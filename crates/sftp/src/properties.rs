use crate::*;
use russh_sftp::protocol::FileAttributes;
use serverdeck_core::IpcError;

pub(crate) struct PropertyJob {
    request_id: String,
    cancel: CancellationToken,
    done: CancellationToken,
}

struct JobGuard {
    files: Files,
    id: String,
    job: Arc<PropertyJob>,
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        if let Ok(mut jobs) = self.files.property_jobs.lock() {
            jobs.remove(&self.id);
        }
        self.job.done.cancel();
    }
}

fn check(cancel: &CancellationToken) -> Result<(), Error> {
    if cancel.is_cancelled() {
        Err(fail(
            "PROPERTIES_CANCELLED",
            "属性操作已停止，已应用的修改不会回退",
        ))
    } else {
        Ok(())
    }
}

impl Files {
    pub async fn property_operation(
        &self,
        id: &str,
        input: PropertyRequest,
    ) -> Result<PropertyResult, Error> {
        remote_absolute(&input.path)?;
        uuid::Uuid::parse_str(&input.request_id)
            .map_err(|_| Error::Validation("属性操作标识无效"))?;
        self.engine.session_info(id)?;
        if let PropertyOperation::Apply { change } = &input.operation {
            if !change.confirmed
                || change.expected.path != input.path
                || change.permissions.is_some_and(|mode| mode > 0o7777)
                || change.uid == Some(u32::MAX)
                || change.gid == Some(u32::MAX)
                || (change.permissions.is_none() && change.uid.is_none() && change.gid.is_none())
                || (change.directory_execute && change.permissions.is_none())
            {
                return Err(Error::Validation(
                    "属性修改须确认有效的权限、属主或组及原始路径",
                ));
            }
            if input.path == "/" && change.recursive {
                return Err(Error::Validation("不能递归修改远程根目录属性"));
            }
        }
        let job = Arc::new(PropertyJob {
            request_id: input.request_id.clone(),
            cancel: CancellationToken::new(),
            done: CancellationToken::new(),
        });
        {
            let mut jobs = locked(&self.property_jobs)?;
            if self.stopping.load(std::sync::atomic::Ordering::Acquire) {
                return Err(Error::ShuttingDown);
            }
            if jobs.contains_key(id) || jobs.len() >= 4 {
                return Err(Error::Busy);
            }
            jobs.insert(id.into(), job.clone());
        }
        let _job = JobGuard {
            files: self.clone(),
            id: id.into(),
            job: job.clone(),
        };
        let _permit = self.slot().await?;
        let remote = self.client(id).await?;
        let mut result = PropertyResult::default();
        let outcome = {
            let operation =
                self.run_property_operation(id, &remote, &input, &job.cancel, &mut result);
            tokio::pin!(operation);
            tokio::select! {
                outcome = &mut operation => outcome,
                _ = tokio::time::sleep(std::time::Duration::from_secs(300)) => {
                    job.cancel.cancel();
                    operation.await
                }
            }
        };
        // All pending reads and directory handles have drained before returning a result.
        if let Err(error) = outcome {
            result.cancelled = job.cancel.is_cancelled();
            if !result.cancelled {
                tracing::warn!(operation = "files_properties", error = %error, "remote property operation failed");
            }
            result.message = Some(if result.cancelled {
                "属性操作已停止（取消或达到五分钟上限），结果可能不完整；已应用的修改不会回退"
                    .into()
            } else {
                IpcError::from(error).message
            });
        }
        Ok(result)
    }

    pub async fn cancel_property_operation(&self, id: &str, request_id: &str) -> Result<(), Error> {
        let job = locked(&self.property_jobs)?
            .get(id)
            .filter(|job| job.request_id == request_id)
            .cloned();
        if let Some(job) = job {
            job.cancel.cancel();
            job.done.cancelled().await;
        }
        Ok(())
    }

    pub(crate) async fn cancel_property_jobs(&self, id: Option<&str>) -> Result<(), Error> {
        let jobs: Vec<_> = locked(&self.property_jobs)?
            .iter()
            .filter(|(session, _)| id.is_none_or(|id| session.as_str() == id))
            .map(|(_, job)| job.clone())
            .collect();
        for job in &jobs {
            job.cancel.cancel();
        }
        for job in jobs {
            job.done.cancelled().await;
        }
        Ok(())
    }

    async fn run_property_operation(
        &self,
        id: &str,
        remote: &Remote,
        input: &PropertyRequest,
        cancel: &CancellationToken,
        result: &mut PropertyResult,
    ) -> Result<(), Error> {
        check(cancel)?;
        let mutation = self.mutation(id)?;
        let _mutation = if matches!(input.operation, PropertyOperation::Apply { .. }) {
            Some(
                tokio::select! { guard = mutation.lock() => guard, _ = cancel.cancelled() => return check(cancel) },
            )
        } else {
            None
        };
        check(cancel)?;
        let root = guard(remote, remote.attrs(&input.path)).await?;
        if !matches!(remote::kind(&root), EntryKind::File | EntryKind::Directory) {
            return Err(Error::Validation(
                "属性计算和修改只支持普通文件或目录，不跟随符号链接",
            ));
        }
        if let PropertyOperation::Apply { change } = &input.operation {
            let current = remote::entry(change.expected.name.clone(), input.path.clone(), &root);
            let expected = &change.expected;
            if current.kind != expected.kind
                || current.size != expected.size
                || current.modified != expected.modified
                || current.permissions != expected.permissions
                || current.uid != expected.uid
                || current.gid != expected.gid
            {
                return Err(Error::Conflict);
            }
        }
        if matches!(input.operation, PropertyOperation::Checksum) {
            if remote::kind(&root) != EntryKind::File {
                return Err(Error::Validation("SHA-256 校验只支持普通文件"));
            }
            if guard(remote, remote.canonical(&input.path)).await? != input.path {
                return Err(Error::Conflict);
            }
            let checksum =
                guard(remote, remote.hash_cancellable(&input.path, Some(cancel))).await?;
            if !remote::same(&root, &guard(remote, remote.attrs(&input.path)).await?) {
                return Err(Error::Conflict);
            }
            result.checksum = Some(checksum);
            return Ok(());
        }
        let recursive = match &input.operation {
            PropertyOperation::Size => true,
            PropertyOperation::Apply { change } => change.recursive,
            _ => false,
        };
        let mut pending = vec![(input.path.clone(), 0usize)];
        let mut targets = Vec::new();
        let mut path_bytes = input.path.len();
        let mut visited = 0usize;
        while let Some((path, depth)) = pending.pop() {
            check(cancel)?;
            visited += 1;
            let attrs = guard(remote, remote.attrs(&path)).await?;
            if path == input.path && !remote::same(&root, &attrs) {
                return Err(Error::Conflict);
            }
            if visited + pending.len() > TREE_LIMIT || depth > 128 || path_bytes > 16 * 1024 * 1024
            {
                return Err(Error::Validation(
                    "属性扫描超过 100000 项、128 层或 16 MiB 路径上限，请缩小范围",
                ));
            }
            match remote::kind(&attrs) {
                EntryKind::File => {
                    result.files += 1;
                    result.bytes = result
                        .bytes
                        .checked_add(attrs.size.ok_or_else(|| {
                            fail("SFTP_ATTRIBUTES", "文件大小未知，无法完整计算属性")
                        })?)
                        .ok_or_else(|| fail("SFTP_LIMIT", "目录大小超过可表示范围"))?;
                }
                EntryKind::Directory => {
                    result.directories += 1;
                    if recursive {
                        // Canonical paths stop traversal if a directory has become a link.
                        if guard(remote, remote.canonical(&path)).await? != path {
                            return Err(Error::Conflict);
                        }
                        for (name, _) in
                            guard(remote, remote.entries_with_cancel(&path, Some(cancel))).await?
                        {
                            let child_path = remote_join(&path, &name)?;
                            path_bytes += child_path.len();
                            pending.push((child_path, depth + 1));
                            if visited + pending.len() > TREE_LIMIT || path_bytes > 16 * 1024 * 1024
                            {
                                return Err(Error::Validation(
                                    "属性扫描超过项目或路径上限，请缩小范围",
                                ));
                            }
                        }
                    }
                }
                _ => {
                    result.skipped_links += 1;
                    continue;
                }
            }
            targets.push((path, attrs));
        }
        if let PropertyOperation::Apply { change } = &input.operation {
            // Children first: removing directory access must not block its descendants.
            for (path, before) in targets.into_iter().rev() {
                check(cancel)?;
                if guard(remote, remote.canonical(&path)).await? != path
                    || !remote::same(&before, &guard(remote, remote.attrs(&path)).await?)
                {
                    return Err(Error::Conflict);
                }
                let permissions = change.permissions.map(|mode| {
                    if change.directory_execute && remote::kind(&before) == EntryKind::Directory {
                        mode | ((mode & 0o444) >> 2)
                    } else {
                        mode
                    }
                });
                if change.uid.is_some() || change.gid.is_some() {
                    let uid = change
                        .uid
                        .or(before.uid)
                        .ok_or_else(|| fail("SFTP_ATTRIBUTES", "服务器未提供 UID，无法保留属主"))?;
                    let gid = change
                        .gid
                        .or(before.gid)
                        .ok_or_else(|| fail("SFTP_ATTRIBUTES", "服务器未提供 GID，无法保留分组"))?;
                    guard(remote, async {
                        remote
                            .raw
                            .setstat(
                                &path,
                                FileAttributes {
                                    uid: Some(uid),
                                    gid: Some(gid),
                                    ..Default::default()
                                },
                            )
                            .await
                            .map_err(remote::map)?;
                        Ok(())
                    })
                    .await?;
                    // Ownership changes may clear set-ID bits, so chmod follows chown.
                    result.changed += 1;
                }
                if let Some(mode) = permissions {
                    guard(remote, async {
                        remote
                            .raw
                            .setstat(
                                &path,
                                FileAttributes {
                                    permissions: Some(mode),
                                    ..Default::default()
                                },
                            )
                            .await
                            .map_err(remote::map)?;
                        Ok(())
                    })
                    .await?;
                    if change.uid.is_none() && change.gid.is_none() {
                        result.changed += 1;
                    }
                }
                let after = guard(remote, remote.attrs(&path)).await?;
                if permissions
                    .is_some_and(|mode| after.permissions.map(|v| v & 0o7777) != Some(mode))
                    || change.uid.is_some_and(|uid| after.uid != Some(uid))
                    || change.gid.is_some_and(|gid| after.gid != Some(gid))
                {
                    return Err(fail(
                        "SFTP_ATTRIBUTES",
                        "服务器未应用请求的属性，请刷新核对已修改项目",
                    ));
                }
            }
        }
        Ok(())
    }
}
