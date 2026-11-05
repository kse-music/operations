use super::*;

impl Repository {
    /// Retain old records as inactive history before decoding removed SDK contracts.
    pub(super) fn retire_removed_tools(&self) -> Result<(), Error> {
        for entry in fs::read_dir(self.root.join("packages")).map_err(io)? {
            let entry = entry.map_err(io)?;
            check_directory(&entry.path())?;
            let id = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("插件目录名无效"))?;
            validate_id(&id)?;
            let path = entry.path().join("record.json");
            if !path.try_exists().map_err(io)? {
                continue;
            }
            let mut record: serde_json::Value =
                serde_json::from_slice(&read_bounded(&path, 128 * 1024)?)
                    .map_err(|e| Error::Storage(Box::new(e)))?;
            let merged_system = record["current"]["source"] == "system"
                && [
                    "cn.hiboot.plugins.",
                    serverdeck_core::identity::LEGACY_PLUGIN_PREFIX,
                ]
                .iter()
                .any(|prefix| {
                    matches!(
                        id.strip_prefix(prefix),
                        Some("resources" | "processes" | "logs" | "network")
                    )
                });
            let has_network = |plugin: &serde_json::Value| {
                plugin["manifest"]["permissions"]
                    .as_array()
                    .is_some_and(|permissions| {
                        permissions
                            .iter()
                            .any(|permission| permission == "network.run")
                    })
                    || plugin["manifest"]["contributions"]
                        .as_array()
                        .is_some_and(|entries| {
                            entries.iter().any(|entry| entry["tool"] == "network")
                        })
            };
            let has_removed_permission = |plugin: &serde_json::Value| {
                has_network(plugin)
                    || plugin["manifest"]["permissions"]
                        .as_array()
                        .is_some_and(|permissions| {
                            permissions.iter().any(|permission| {
                                matches!(
                                    permission.as_str(),
                                    Some("batch.run" | "automation.manage" | "tasks.create")
                                )
                            })
                        })
            };
            let removed = merged_system
                || crate::manifest::is_removed_tool_id(&id)
                || has_removed_permission(&record["current"])
                || self.has_removed_server_view(&id, &record["current"])?;
            if !removed {
                if !record["backup"].is_null()
                    && (has_removed_permission(&record["backup"])
                        || self.has_removed_server_view(&id, &record["backup"])?)
                {
                    let archive = self
                        .root
                        .join("retired")
                        .join(format!("{id}-contract-{}", uuid::Uuid::new_v4()));
                    ensure_directory(&archive)?;
                    self.archive_backup_payload(&id, &record["backup"], &archive)?;
                    write_json(&archive.join("record.json"), &record)?;
                    write_json(
                        &archive.join("reason.json"),
                        &serde_json::json!({"message":"旧备份使用已移除的插件合同，已归档；请升级插件使用独立界面。"}),
                    )?;
                    record["backup"] = serde_json::Value::Null;
                    record["current"]["previousVersion"] = serde_json::Value::Null;
                    write_json(&path, &record)?;
                }
                continue;
            }
            let archive = self.root.join("retired");
            ensure_directory(&archive)?;
            let target = archive.join(format!("{id}-removed-{}", uuid::Uuid::new_v4()));
            check_ancestors(&target)?;
            fs::rename(entry.path(), &target).map_err(io)?;
            write_json(
                &target.join("reason.json"),
                &serde_json::json!({"message":"插件身份或标准界面已移除，原包和用户数据保留；第三方插件需升级为独立界面。"}),
            )?;
        }
        Ok(())
    }

    fn archive_backup_payload(
        &self,
        id: &str,
        raw: &serde_json::Value,
        archive: &Path,
    ) -> Result<(), Error> {
        use base64::Engine as _;
        let base = self.retirement_payload_folder(id, raw)?;
        let files = raw["manifest"]["files"]
            .as_array()
            .ok_or_else(|| invalid("插件文件清单无效"))?;
        let mut archived = Vec::new();
        let mut total = 0;
        if files.len() > crate::package::MAX_FILES {
            return Err(invalid("插件文件清单超限"));
        }
        for file in files {
            let name = file["path"]
                .as_str()
                .ok_or_else(|| invalid("插件文件路径无效"))?;
            validate_path(name)?;
            let path = base.join(name);
            check_ancestors(&path)?;
            let bytes = read_bounded(&path, crate::package::MAX_FILE as u64)?;
            total += bytes.len();
            if total > crate::package::MAX_TOTAL
                || file["size"].as_u64() != Some(bytes.len() as u64)
                || file["sha256"].as_str() != Some(digest(&bytes).as_str())
            {
                return Err(invalid("插件备份文件大小或摘要不符"));
            }
            archived.push(serde_json::json!({"path":name,"content":base64::engine::general_purpose::STANDARD.encode(bytes)}));
        }
        write_json(
            &archive.join("package.sdplugin"),
            &serde_json::json!({"formatVersion":1,"manifest":raw["manifest"],"files":archived}),
        )
    }

    fn retirement_payload_folder(
        &self,
        id: &str,
        raw: &serde_json::Value,
    ) -> Result<PathBuf, Error> {
        let revision = raw["revision"]
            .as_str()
            .ok_or_else(|| invalid("插件存储代号缺失"))?;
        validate_path(revision)?;
        if revision.contains('/') || !revision.starts_with("version-") {
            return Err(invalid("插件存储代号无效"));
        }
        let source = match raw["source"].as_str() {
            None | Some("user") => PluginSource::User,
            Some("system") => PluginSource::System,
            _ => return Err(invalid("插件来源无效")),
        };
        // Retirement precedes payload migration; accept either owned layout.
        let legacy = self.folder(id)?.join("versions").join(revision);
        let base = if legacy.try_exists().map_err(io)? {
            legacy
        } else {
            self.payload_folder(source, id)?
                .join("versions")
                .join(revision)
        };
        check_directory(&base)?;
        Ok(base)
    }

    fn has_removed_server_view(&self, id: &str, raw: &serde_json::Value) -> Result<bool, Error> {
        if raw["manifest"]["entry"]["ui"].is_null() {
            return Ok(false);
        }
        let plugin: InstalledPlugin =
            serde_json::from_value(raw.clone()).map_err(|error| Error::Storage(Box::new(error)))?;
        if plugin.manifest.id != id {
            return Err(invalid("插件仓库身份不一致"));
        }
        let path = plugin
            .manifest
            .entry
            .ui
            .as_deref()
            .ok_or_else(|| invalid("插件 UI 入口缺失"))?;
        validate_path(path)?;
        let file = plugin
            .manifest
            .files
            .iter()
            .find(|file| file.path == path)
            .ok_or_else(|| invalid("插件 UI 文件未声明"))?;
        let base = self.retirement_payload_folder(id, raw)?;
        let target = base.join(path);
        check_ancestors(&target)?;
        let bytes = read_bounded(&target, 64 * 1024)?;
        if bytes.len() as u64 != file.size || digest(&bytes) != file.sha256 {
            return Err(invalid("已安装插件 UI 文件被修改"));
        }
        let ui: serde_json::Value =
            serde_json::from_slice(&bytes).map_err(|error| Error::Storage(Box::new(error)))?;
        Ok(crate::package::uses_removed_server_view(&ui))
    }

    pub(super) fn payload_folder(&self, source: PluginSource, id: &str) -> Result<PathBuf, Error> {
        validate_id(id)?;
        let path = self
            .root
            .join(match source {
                PluginSource::User => "upload",
                PluginSource::System => "system",
            })
            .join(id);
        check_ancestors(&path)?;
        Ok(path)
    }

    /// Move only owned version directories. Records, revisions, grants and settings
    /// stay unchanged, so interruption between atomic renames is resumable.
    pub(super) fn migrate_payload_layout(&self) -> Result<(), Error> {
        let root = self.root.canonicalize().map_err(io)?;
        let mut moves = Vec::new();
        for entry in fs::read_dir(self.root.join("packages")).map_err(io)? {
            let entry = entry.map_err(io)?;
            check_directory(&entry.path())?;
            let id = entry
                .file_name()
                .into_string()
                .map_err(|_| invalid("插件目录名无效"))?;
            validate_id(&id)?;
            let legacy = entry.path().join("versions");
            if !legacy.try_exists().map_err(io)? {
                continue;
            }
            check_directory(&legacy)?;
            let record = self.record(&id)?;
            for item in fs::read_dir(&legacy).map_err(io)? {
                let item = item.map_err(io)?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| invalid("插件版本目录名无效"))?;
                validate_path(&name)?;
                if !name.starts_with("version-") || name.contains('/') {
                    return Err(invalid("插件版本目录含未知产物"));
                }
                let source = record
                    .backup
                    .as_ref()
                    .filter(|p| p.revision == name)
                    .unwrap_or(&record.current)
                    .source;
                let destination = self.payload_folder(source, &id)?.join("versions");
                ensure_directory(&destination)?;
                check_directory(&item.path())?;
                verify_tree(&item.path())?;
                if !item.path().canonicalize().map_err(io)?.starts_with(&root)
                    || !destination.canonicalize().map_err(io)?.starts_with(&root)
                {
                    return Err(invalid("插件迁移路径超出仓库"));
                }
                let target = destination.join(name);
                if target.try_exists().map_err(io)? {
                    return Err(invalid("插件迁移目标已存在，原数据保持不变"));
                }
                moves.push((item.path(), target));
            }
        }
        for (source, target) in moves {
            fs::rename(source, target).map_err(io)?;
        }
        Ok(())
    }

    /// Domain changes create a new identity and require fresh grants. Keep the
    /// previous installation record and authorization as inactive local history.
    pub fn retire_bundled_identity(&self, old: &str, new: &str) -> Result<(), Error> {
        let previous = self.detail(old)?;
        if previous.source != PluginSource::System {
            return Err(invalid("不能迁移用户上传包的身份"));
        }
        let replacement = match self.detail(new) {
            Ok(plugin) => Some(plugin),
            Err(Error::NotFound) => None,
            Err(error) => return Err(error),
        };
        let archive = self.root.join("retired");
        ensure_directory(&archive)?;
        let target = archive.join(old);
        check_ancestors(&target)?;
        if target.try_exists().map_err(io)? {
            return Err(invalid("旧插件迁移记录已存在"));
        }
        let old_data = self.root.join("data").join(old);
        let new_data = self.root.join("data").join(new);
        check_ancestors(&old_data)?;
        check_ancestors(&new_data)?;
        if replacement.is_some_and(|p| p.source == PluginSource::System)
            && old_data.try_exists().map_err(io)?
            && !new_data.try_exists().map_err(io)?
        {
            check_directory(&old_data)?;
            verify_tree(&old_data)?;
            fs::rename(&old_data, &new_data).map_err(io)?;
        }
        let source = self.folder(old)?;
        check_directory(&source)?;
        verify_tree(&source)?;
        fs::rename(source, target).map_err(io)
    }
}
