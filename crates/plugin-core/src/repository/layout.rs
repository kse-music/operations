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
}
