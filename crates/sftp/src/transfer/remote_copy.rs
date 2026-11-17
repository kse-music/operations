use super::*;

#[derive(Clone)]
pub(super) struct Job {
    pub name: Option<String>,
    pub target_session: Option<String>,
    pub target_closed: Option<CancellationToken>,
}
struct Item {
    source: String,
    destination: String,
    before: FileAttributes,
    target: Option<FileAttributes>,
    skip: bool,
}
struct LeaseGuard {
    engine: serverdeck_ssh::Engine,
    session: String,
    target: String,
}
impl CopyGuard for LeaseGuard {
    fn check(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send + '_>> {
        Box::pin(async {
            self.engine.session_info(&self.session)?;
            self.engine.session_info(&self.target).map(|_| ())
        })
    }
}

impl Transfers {
    pub fn start_remote_copy(&self, mut input: RemoteCopyInput) -> Result<TransferInfo, Error> {
        input.validate()?;
        if let Some(target) = &input.target_session_id
            && self.engine.session_info(target)?.host_id
                == self.engine.session_info(&input.session_id)?.host_id
        {
            let mut same_host = input.clone();
            same_host.target_session_id = None;
            same_host.validate()?;
        }
        let target_session = input
            .target_session_id
            .filter(|target| target != &input.session_id);
        let destination = input.destination.trim_end_matches('/');
        input.destination = if destination.is_empty() {
            "/".into()
        } else {
            destination.into()
        };
        self.enqueue(
            TransferInput {
                session_id: input.session_id,
                direction: Direction::Upload,
                sources: input.sources,
                destination: input.destination,
                conflict: input.conflict,
                confirm_overwrite: input.confirm_overwrite,
            },
            false,
            None,
            Some(Job {
                name: input.name,
                target_session,
                target_closed: None,
            }),
        )
        .map(|(info, _)| info)
    }
}

fn matches_target(expected: Option<&FileAttributes>, actual: Option<&FileAttributes>) -> bool {
    match (expected, actual) {
        (None, None) => true,
        (Some(a), Some(b)) => remote::same(a, b),
        _ => false,
    }
}
async fn canonical_parent(remote: &Remote, path: &str) -> Result<(), Error> {
    let parent = remote_parent(path).ok_or(Error::Validation("远程项目没有父目录"))?;
    if remote.canonical(&parent).await? != parent {
        return Err(Error::Conflict);
    }
    Ok(())
}
async fn plan(
    task: &Task,
    source_remote: &Remote,
    remote: &Remote,
    job: &Job,
) -> Result<Vec<Item>, Error> {
    let destination = &task.input.destination;
    if remote.canonical(destination).await? != *destination
        || remote::kind(&remote.attrs(destination).await?) != EntryKind::Directory
    {
        return Err(Error::Validation(
            "目标必须是已有的规范远程目录，不能是链接",
        ));
    }
    let mut pending = Vec::new();
    let mut bytes = 0usize;
    for source in task.input.sources.iter().rev() {
        let name = job
            .name
            .as_deref()
            .unwrap_or_else(|| source.rsplit('/').next().unwrap_or(""));
        let target = remote_join(destination, name)?;
        bytes += source.len() + target.len();
        pending.push((source.clone(), target, 0usize));
    }
    let mut items = Vec::new();
    while let Some((source, destination, depth)) = pending.pop() {
        task.check_cancel()?;
        if items.len() + pending.len() + 1 > TREE_LIMIT || depth > 64 || bytes > 16 * 1024 * 1024 {
            return Err(Error::Validation(
                "远程操作超过 100000 项、64 层或 16 MiB 路径上限",
            ));
        }
        canonical_parent(source_remote, &source).await?;
        let before = source_remote.attrs(&source).await?;
        let kind = remote::kind(&before);
        let unsupported = !matches!(kind, EntryKind::File | EntryKind::Directory);
        if unsupported && depth == 0 {
            return Err(Error::Validation("远程复制不支持链接或特殊文件"));
        }
        if !unsupported && source_remote.canonical(&source).await? != source {
            return Err(Error::Conflict);
        }
        let target = remote.optional_attrs(&destination).await?;
        let skip = unsupported || (target.is_some() && task.input.conflict == ConflictPolicy::Skip);
        if let Some(target) = &target
            && !skip
        {
            if task.input.conflict == ConflictPolicy::Fail {
                return Err(fail("FILE_CONFLICT", "目标已存在，请选择跳过或确认覆盖"));
            }
            let target_kind = remote::kind(target);
            let merging = kind == EntryKind::Directory && target_kind == EntryKind::Directory;
            if !merging && (target_kind != EntryKind::File || kind == EntryKind::Directory) {
                return Err(Error::Validation(
                    "不能覆盖目录、链接或特殊文件；复制目录仅可合并已有目录",
                ));
            }
            if !merging && !remote.atomic {
                return Err(fail(
                    "SFTP_ATOMIC_UNSUPPORTED",
                    "服务器不支持原子覆盖，原目标保留",
                ));
            }
            if merging && remote.canonical(&destination).await? != destination {
                return Err(Error::Conflict);
            }
            if !merging {
                remote.writable(&destination).await?;
            }
        }
        if !skip && kind == EntryKind::File && before.size.is_none() {
            return Err(fail("SFTP_ATTRIBUTES", "源文件大小未知，无法复制"));
        }
        if !skip && kind == EntryKind::Directory {
            for (name, _) in source_remote
                .entries_with_cancel(&source, Some(&task.cancel))
                .await?
                .into_iter()
                .rev()
            {
                let child_source = remote_join(&source, &name)?;
                let child_target = remote_join(&destination, &name)?;
                bytes += child_source.len() + child_target.len();
                pending.push((child_source, child_target, depth + 1));
                if items.len() + pending.len() + 1 > TREE_LIMIT || bytes > 16 * 1024 * 1024 {
                    return Err(Error::Validation("远程操作超过项目或路径上限"));
                }
            }
        }
        items.push(Item {
            source,
            destination,
            before,
            target,
            skip,
        });
    }
    Ok(items)
}

pub(super) async fn run(
    transfers: &Transfers,
    task: &Task,
    remote: &Remote,
    job: &Job,
) -> Result<(), Error> {
    let source_connection = if job.target_session.is_some() {
        Some(Remote::connect(&transfers.engine, &task.input.session_id).await?)
    } else {
        None
    };
    let source_remote = source_connection.as_deref().unwrap_or(remote);
    let target_session = job
        .target_session
        .as_deref()
        .unwrap_or(&task.input.session_id);
    let items = plan(task, source_remote, remote, job).await?;
    {
        let mut info = locked(&task.info)?;
        info.files_total = items.len();
        info.total_bytes = items
            .iter()
            .filter(|item| remote::kind(&item.before) == EntryKind::File)
            .try_fold(0u64, |sum, item| {
                sum.checked_add(item.before.size.unwrap_or(0))
            })
            .ok_or(Error::Validation("复制总大小溢出"))?;
    }
    let host = transfers.engine.session_info(target_session)?.host_id;
    let mutation = locked(&transfers.mutations)?
        .entry(host)
        .or_default()
        .clone();
    let guard: Arc<dyn CopyGuard> = Arc::new(LeaseGuard {
        engine: transfers.engine.clone(),
        session: task.input.session_id.clone(),
        target: target_session.into(),
    });
    for item in &items {
        task.check_cancel()?;
        if item.skip {
            task.skip(if remote::kind(&item.before) == EntryKind::File {
                item.before.size.unwrap_or(0)
            } else {
                0
            });
            continue;
        }
        task.state("running");
        canonical_parent(source_remote, &item.source).await?;
        if !remote::same(&item.before, &source_remote.attrs(&item.source).await?) {
            return Err(Error::Conflict);
        }
        if remote::kind(&item.before) == EntryKind::Directory {
            let _mutation = mutation.lock().await;
            canonical_parent(remote, &item.destination).await?;
            let target = remote.optional_attrs(&item.destination).await?;
            if !matches_target(item.target.as_ref(), target.as_ref()) {
                return Err(Error::Conflict);
            }
            task.check_cancel()?;
            guard.check().await?;
            if target.is_none() {
                remote.mkdir(&item.destination).await?;
            }
            if remote.canonical(&item.destination).await? != item.destination {
                return Err(Error::Conflict);
            }
            task.finished();
        } else {
            let file = copy::remote_job(
                &task.input.session_id,
                target_session,
                item.source.clone(),
                item.destination.clone(),
                item.before.clone(),
                item.target.clone(),
                guard.clone(),
            );
            copy::run(
                &transfers.engine,
                &transfers.mutations,
                task,
                remote,
                &file,
                true,
            )
            .await?;
        }
    }
    // Detect directory changes during a recursive copy; completed targets remain visible on failure.
    for item in items
        .iter()
        .rev()
        .filter(|item| !item.skip && remote::kind(&item.before) == EntryKind::Directory)
    {
        task.check_cancel()?;
        canonical_parent(source_remote, &item.source).await?;
        if source_remote.canonical(&item.source).await? != item.source
            || !remote::same(&item.before, &source_remote.attrs(&item.source).await?)
        {
            return Err(Error::Conflict);
        }
        if item.target.is_none() {
            let _mutation = mutation.lock().await;
            if remote.canonical(&item.destination).await? != item.destination {
                return Err(Error::Conflict);
            }
            let mode = item.before.permissions.unwrap_or(0o755) & 0o777;
            task.check_cancel()?;
            guard.check().await?;
            remote
                .raw
                .setstat(
                    &item.destination,
                    FileAttributes {
                        permissions: Some(mode),
                        ..Default::default()
                    },
                )
                .await
                .map_err(remote::map)?;
            if remote
                .attrs(&item.destination)
                .await?
                .permissions
                .map(|value| value & 0o777)
                != Some(mode)
            {
                return Err(fail("SFTP_ATTRIBUTES", "服务器未保留复制目录的基本权限"));
            }
        }
    }
    Ok(())
}
