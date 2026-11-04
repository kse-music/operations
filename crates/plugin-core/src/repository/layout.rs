use super::*;

impl Repository {
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
