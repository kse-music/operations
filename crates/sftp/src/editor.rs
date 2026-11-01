use crate::remote;
use crate::*;
use russh_sftp::protocol::FileAttributes;
use sha2::{Digest, Sha256};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct Document {
    pub public: TextDocument,
    pub attrs: FileAttributes,
    pub dirty: bool,
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
            },
        );
        Ok(public)
    }
    pub fn editor_dirty(&self, token: &str, dirty: bool) -> Result<(), Error> {
        locked(&self.documents)?
            .get_mut(token)
            .ok_or(Error::NotFound)?
            .dirty = dirty;
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
        let document = locked(&self.documents)?
            .get(&input.token)
            .cloned()
            .ok_or(Error::NotFound)?;
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
        let (_, hash, attrs) = remote.read_text(&document.public.path).await?;
        if hash != document.public.sha256 || !remote::same(&attrs, &document.attrs) {
            return Err(fail(
                "EDITOR_CONFLICT",
                "文件内容、属主、权限或时间已被外部修改，请重新加载后合并；未覆盖",
            ));
        }
        remote.writable(&document.public.path).await?;
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
            let writing = async {
                for (offset, data) in input.content.as_bytes().chunks(32768).enumerate() {
                    remote
                        .raw
                        .write(&handle, (offset * 32768) as u64, data.to_vec())
                        .await
                        .map_err(remote::map)?;
                }
                Ok::<_, Error>(())
            }
            .await;
            let closing = remote.close_write(handle).await;
            writing?;
            closing?;
            let hash = format!("{:x}", Sha256::digest(input.content.as_bytes()));
            if remote.hash(&temporary).await? != hash {
                return Err(fail("EDITOR_HASH", "临时文件校验失败，原文件保留"));
            }
            remote.preserve(&temporary, &attrs).await?;
            let (_, current_hash, current_attrs) = remote.read_text(&document.public.path).await?;
            if current_hash != document.public.sha256
                || !remote::same(&current_attrs, &attrs)
                || remote.canonical(&parent).await? != parent
            {
                return Err(fail(
                    "EDITOR_CONFLICT",
                    "保存期间文件被外部修改，原文件未覆盖",
                ));
            }
            remote
                .replace(&temporary, &document.public.path, true)
                .await?;
            let attrs = remote.attrs(&document.public.path).await?;
            let public = TextDocument {
                content: input.content,
                sha256: hash,
                permissions: attrs.permissions.map(|v| v & 0o7777),
                uid: attrs.uid,
                gid: attrs.gid,
                ..document.public
            };
            locked(&self.documents)?.insert(
                input.token,
                Document {
                    public: public.clone(),
                    attrs,
                    dirty: false,
                },
            );
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
