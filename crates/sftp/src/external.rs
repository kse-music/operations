use crate::{editor::Document, local, remote, *};
use std::path::{Path, PathBuf};
use uuid::Uuid;

#[derive(Clone)]
pub(crate) struct ExternalState {
    pub path: PathBuf,
    pub transfer_id: String,
    pub ready: bool,
    pub cancel: CancellationToken,
}

fn public(document: &Document) -> Result<ExternalDocument, Error> {
    let external = document.external.as_ref().ok_or(Error::NotFound)?;
    Ok(ExternalDocument {
        token: document.public.token.clone(),
        session_id: document.public.session_id.clone(),
        path: document.public.path.clone(),
        local_path: local::text(&external.path)?,
        transfer_id: external.transfer_id.clone(),
        atomic_save: document.public.atomic_save,
        ready: external.ready,
    })
}

pub(crate) async fn local_metadata(path: &Path) -> Result<std::fs::Metadata, Error> {
    for ancestor in path.ancestors() {
        let metadata = tokio::fs::symlink_metadata(ancestor)
            .await
            .map_err(local::io)?;
        if local::link(&metadata) {
            return Err(fail(
                "EDITOR_LOCAL_PATH",
                "外部编辑副本路径包含链接或重解析点，未读取或回传",
            ));
        }
    }
    let metadata = tokio::fs::symlink_metadata(path).await.map_err(local::io)?;
    if !metadata.is_file() {
        return Err(Error::Validation("外部编辑副本必须是普通文件"));
    }
    Ok(metadata)
}

impl Files {
    pub async fn prepare_external(
        &self,
        session: &str,
        path: &str,
        directory: &Path,
    ) -> Result<ExternalDocument, Error> {
        remote_absolute(path)?;
        let name = path
            .rsplit('/')
            .next()
            .ok_or(Error::Validation("文件名无效"))?;
        local::validate_name(name)?;
        let _permit = self.slot().await?;
        let remote = self.client(session).await?;
        let attrs = guard(&remote, remote.attrs(path)).await?;
        if remote::kind(&attrs) != EntryKind::File {
            return Err(Error::Validation(
                "外部编辑只支持普通文件，不直接编辑链接或特殊文件",
            ));
        }
        let mut documents = locked(&self.documents)?;
        if documents.len() >= 8 {
            return Err(fail(
                "EDITOR_LIMIT",
                "最多保留 8 个编辑文档，请先关闭不需要的文档",
            ));
        }
        let transfer = self.transfers.start(TransferInput {
            session_id: session.into(),
            direction: Direction::Download,
            sources: vec![path.into()],
            destination: local::text(directory)?,
            conflict: ConflictPolicy::Fail,
            confirm_overwrite: false,
        })?;
        let token = Uuid::new_v4().to_string();
        let document = Document {
            public: TextDocument {
                token: token.clone(),
                session_id: session.into(),
                path: path.into(),
                content: String::new(),
                sha256: String::new(),
                permissions: attrs.permissions.map(|mode| mode & 0o7777),
                uid: attrs.uid,
                gid: attrs.gid,
                atomic_save: remote.atomic,
            },
            attrs,
            dirty: true,
            external: Some(ExternalState {
                path: directory.join(name),
                transfer_id: transfer.id,
                ready: false,
                cancel: CancellationToken::new(),
            }),
        };
        let result = public(&document)?;
        documents.insert(token, document);
        Ok(result)
    }

    pub async fn external_ready(&self, token: &str) -> Result<ExternalDocument, Error> {
        let mut document = locked(&self.documents)?
            .get(token)
            .cloned()
            .ok_or(Error::NotFound)?;
        let external = document.external.as_ref().ok_or(Error::NotFound)?;
        if external.ready {
            return public(&document);
        }
        let task = self
            .transfers
            .list()?
            .into_iter()
            .find(|task| task.id == external.transfer_id)
            .ok_or(Error::NotFound)?;
        if task.state != "completed" || task.skipped != 0 || task.files_done != 1 {
            return Err(Error::Validation(
                "外部编辑副本尚未成功下载，请检查传输状态",
            ));
        }
        let _permit = self.slot().await?;
        let remote = self.client(&document.public.session_id).await?;
        let before = local_metadata(&external.path).await?;
        let hash = local::hash(&external.path).await?;
        let checking = async {
            if !remote::same(&document.attrs, &remote.attrs(&document.public.path).await?)
                || hash
                    != remote
                        .hash_cancellable(&document.public.path, Some(&external.cancel))
                        .await?
                || !remote::same(&document.attrs, &remote.attrs(&document.public.path).await?)
                || !local::same(&before, &local_metadata(&external.path).await?)
            {
                return Err(fail(
                    "EDITOR_CONFLICT",
                    "下载期间原文件或本地副本发生变化，未启动外部编辑，请重新打开",
                ));
            }
            Ok(())
        };
        guard(&remote, checking).await?;
        document.public.sha256 = hash;
        if let Some(external) = &mut document.external {
            external.ready = true;
        }
        let result = public(&document)?;
        let mut documents = locked(&self.documents)?;
        if !documents.contains_key(token) {
            return Err(Error::NotFound);
        }
        documents.insert(token.into(), document);
        Ok(result)
    }
}
