use crate::remote;
use crate::*;
use russh_sftp::protocol::FileAttributes;
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Document {
    pub public: TextDocument,
    pub attrs: FileAttributes,
    pub dirty: bool,
    pub external: Option<crate::external::ExternalState>,
}
impl Files {
    pub async fn read_text(&self, session: &str, path: &str) -> Result<TextDocument, Error> {
        remote_absolute(path)?;
        let _permit = self.slot().await?;
        let remote = self.client(session).await?;
        let (content, sha256, attrs) = guard(&remote, remote.read_text(path)).await?;
        let public = TextDocument {
            token: Uuid::new_v4().to_string(),
            session_id: session.into(),
            path: path.into(),
            content,
            sha256,
            permissions: attrs.permissions.map(|v| v & 0o7777),
            uid: attrs.uid,
            gid: attrs.gid,
            atomic_save: remote.atomic,
        };
        let mut documents = locked(&self.documents)?;
        if documents.len() >= 8 {
            return Err(fail(
                "EDITOR_LIMIT",
                "最多保留 8 个编辑文档，请先关闭不需要的文档",
            ));
        }
        documents.insert(
            public.token.clone(),
            Document {
                public: public.clone(),
                attrs,
                dirty: false,
                external: None,
            },
        );
        Ok(public)
    }
    pub fn editor_dirty(&self, token: &str, dirty: bool) -> Result<(), Error> {
        let mut documents = locked(&self.documents)?;
        let document = documents.get_mut(token).ok_or(Error::NotFound)?;
        if document.external.is_some() {
            return Err(Error::Validation(
                "外部编辑须显式结束，不能标记为无未保存内容",
            ));
        }
        document.dirty = dirty;
        Ok(())
    }
    pub fn close_editor(&self, token: &str, discard: bool) -> Result<(), Error> {
        let mut documents = locked(&self.documents)?;
        if let Some(doc) = documents.get(token)
            && doc.dirty
            && !discard
        {
            return Err(fail("EDITOR_DIRTY", "文档有未保存内容，请先保存或确认放弃"));
        }
        documents.remove(token);
        Ok(())
    }
    pub async fn save_text(&self, input: SaveText) -> Result<SaveResult, Error> {
        if input.content.len() > TEXT_LIMIT || input.content.contains('\0') {
            return Err(Error::Validation(
                "仅可保存不超过 2 MiB 且无 NUL 的 UTF-8 文本",
            ));
        }
        if !input.confirm_replace {
            return Err(Error::Validation(
                "请确认原子替换的 inode、ACL 和硬链接限制",
            ));
        }
        self.save_document(input.token, Some(input.content)).await
    }
    pub async fn save_external(&self, token: String, confirmed: bool) -> Result<SaveResult, Error> {
        if !confirmed {
            return Err(Error::Validation("回传必须确认覆盖及原子替换限制"));
        }
        {
            let mut documents = locked(&self.documents)?;
            let external = documents
                .get_mut(&token)
                .and_then(|document| document.external.as_mut())
                .ok_or(Error::NotFound)?;
            external.cancel = CancellationToken::new();
        }
        self.save_document(token, None).await
    }
    pub fn cancel_external_save(&self, token: &str) -> Result<(), Error> {
        let documents = locked(&self.documents)?;
        let external = documents
            .get(token)
            .and_then(|document| document.external.as_ref())
            .ok_or(Error::NotFound)?;
        external.cancel.cancel();
        Ok(())
    }
    async fn save_document(
        &self,
        token: String,
        content: Option<String>,
    ) -> Result<SaveResult, Error> {
        let document = locked(&self.documents)?
            .get(&token)
            .cloned()
            .ok_or(Error::NotFound)?;
        let cancellation = document
            .external
            .as_ref()
            .map(|external| external.cancel.clone());
        let cancel = cancellation.as_ref();
        if content.is_some() == document.external.is_some() {
            return Err(Error::Validation("编辑文档类型不匹配"));
        }
        let _permit = self.slot().await?;
        let remote = self.client(&document.public.session_id).await?;
        let mutation = self.mutation(&document.public.session_id)?;
        let _mutation = mutation.lock().await;
        if !remote.atomic {
            return Err(fail(
                "SFTP_ATOMIC_UNSUPPORTED",
                "服务器缺少原子替换扩展，未尝试删除或直接截断原文件",
            ));
        }
        let attrs = remote.attrs(&document.public.path).await?;
        let hash = remote
            .hash_cancellable(&document.public.path, cancel)
            .await?;
        if hash != document.public.sha256 || !remote::same(&attrs, &document.attrs) {
            return Err(fail(
                "EDITOR_CONFLICT",
                "文件内容、属主、权限或时间已被外部修改，请重新加载后合并；未覆盖",
            ));
        }
        remote.writable(&document.public.path).await?;
        let mut local_source = None;
        let mut reader: Box<dyn tokio::io::AsyncRead + Unpin + Send> =
            if let Some(content) = &content {
                Box::new(std::io::Cursor::new(content.as_bytes().to_vec()))
            } else {
                let external = document.external.as_ref().ok_or(Error::NotFound)?;
                if !external.ready {
                    return Err(Error::Validation("外部编辑副本尚未完成下载和校验"));
                }
                let before = crate::external::local_metadata(&external.path).await?;
                let file = tokio::fs::File::open(&external.path)
                    .await
                    .map_err(crate::local::io)?;
                if !crate::local::same(&before, &file.metadata().await.map_err(crate::local::io)?) {
                    return Err(Error::Conflict);
                }
                local_source = Some((external.path.clone(), before));
                Box::new(file)
            };
        let parent =
            remote_parent(&document.public.path).ok_or(Error::Validation("文件没有父目录"))?;
        if remote.canonical(&parent).await? != parent {
            return Err(fail(
                "SFTP_PATH_CHANGED",
                "文件父目录包含链接或发生变化，未保存",
            ));
        }
        let temporary = remote_join(
            &parent,
            &format!(".serverdeck-editor-{}.part", Uuid::new_v4()),
        )?;
        let handle = remote.stage(&temporary).await?;
        let result = async {
            let mut digest = Sha256::new();
            let writing = async {
                let mut buffer = vec![0; 32768];
                let mut offset = 0;
                loop {
                    remote::check_editor_cancel(cancel)?;
                    let n = reader.read(&mut buffer).await.map_err(crate::local::io)?;
                    if n == 0 {
                        break;
                    }
                    if local_source
                        .as_ref()
                        .is_some_and(|(_, metadata)| offset + n as u64 > metadata.len())
                    {
                        return Err(fail(
                            "EDITOR_LOCAL_CHANGED",
                            "本地副本在回传期间增大，请保存后重试",
                        ));
                    }
                    remote
                        .raw
                        .write(&handle, offset, buffer[..n].to_vec())
                        .await
                        .map_err(remote::map)?;
                    digest.update(&buffer[..n]);
                    offset += n as u64;
                }
                Ok::<_, Error>(())
            }
            .await;
            let closing = remote.close_write(handle).await;
            writing?;
            closing?;
            let hash = format!("{:x}", digest.finalize());
            if remote.hash_cancellable(&temporary, cancel).await? != hash {
                return Err(fail("EDITOR_HASH", "临时文件校验失败，原文件保留"));
            }
            remote.preserve(&temporary, &attrs).await?;
            if let Some((path, before)) = &local_source {
                let after = crate::external::local_metadata(path).await?;
                if !crate::local::same(before, &after) || crate::local::hash(path).await? != hash {
                    return Err(fail(
                        "EDITOR_LOCAL_CHANGED",
                        "本地副本在回传期间被修改，请保存后重试；原文件未覆盖",
                    ));
                }
            }
            let current_attrs = remote.attrs(&document.public.path).await?;
            let current_hash = remote
                .hash_cancellable(&document.public.path, cancel)
                .await?;
            if current_hash != document.public.sha256
                || !remote::same(&current_attrs, &attrs)
                || remote.canonical(&parent).await? != parent
            {
                return Err(fail(
                    "EDITOR_CONFLICT",
                    "保存期间文件被外部修改，原文件未覆盖",
                ));
            }
            remote::check_editor_cancel(cancel)?;
            remote
                .replace(&temporary, &document.public.path, true)
                .await?;
            let attrs = remote.attrs(&document.public.path).await?;
            let public = TextDocument {
                content: content.unwrap_or_default(),
                sha256: hash,
                permissions: attrs.permissions.map(|v| v & 0o7777),
                uid: attrs.uid,
                gid: attrs.gid,
                ..document.public
            };
            if let Some(current) = locked(&self.documents)?.get_mut(&token) {
                *current = Document {
                    public: public.clone(),
                    attrs,
                    dirty: document.external.is_some(),
                    external: document.external,
                };
            }
            Ok(public)
        }
        .await;
        match result {
            Ok(document) => Ok(SaveResult {
                document: Some(document),
                recovery_path: None,
                message: None,
            }),
            Err(error) => {
                // A failed replace never falls back to unlinking/truncating the original.
                match remote.raw.remove(&temporary).await {
                    Ok(_) => Err(error),
                    Err(e) if remote::missing(&e) => Err(error),
                    Err(_) => Ok(SaveResult {
                        document: None,
                        recovery_path: Some(temporary),
                        message: Some(format!(
                            "{}；临时文件未能清理，请在文件管理器中检查恢复路径",
                            serverdeck_core::IpcError::from(error).message
                        )),
                    }),
                }
            }
        }
    }
}
