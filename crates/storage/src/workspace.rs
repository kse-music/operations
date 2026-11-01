use super::*;
use serverdeck_core::workspace::WorkspaceLayout;
impl Database {
    pub fn load_workspace(&self) -> Result<Option<WorkspaceLayout>, Error> {
        let json: Option<String> = self
            .connect()?
            .query_row(
                "SELECT value FROM application_settings WHERE key='terminal_workspace'",
                [],
                |r| r.get(0),
            )
            .optional()
            .map_err(storage_error)?;
        let layout = json
            .map(|v| serde_json::from_str::<WorkspaceLayout>(&v).map_err(storage_error))
            .transpose()?;
        if let Some(layout) = &layout {
            layout.validate()?;
        }
        Ok(layout)
    }
    pub fn save_workspace(&self, layout: &WorkspaceLayout) -> Result<(), Error> {
        layout.validate()?;
        let json = serde_json::to_string(layout).map_err(storage_error)?;
        if json.len() > 64 * 1024 {
            return Err(Error::Validation("工作区布局过大"));
        }
        self.connect()?.execute("INSERT INTO application_settings(key,value) VALUES('terminal_workspace',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[json]).map_err(storage_error)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serverdeck_core::workspace::*;
    #[test]
    fn workspace_layout_roundtrip_has_only_metadata_and_rejects_invalid_tree() {
        let dir = tempfile::tempdir().expect("dir");
        let db = Database::open(dir.path().join("db")).expect("database");
        let key = uuid::Uuid::new_v4().to_string();
        let tab = uuid::Uuid::new_v4().to_string();
        let host = uuid::Uuid::new_v4().to_string();
        let mut layout = WorkspaceLayout {
            version: 1,
            active: tab.clone(),
            tabs: vec![SavedTab {
                key: tab,
                title: "My shell".into(),
                panes: vec![SavedPane {
                    key: key.clone(),
                    host_id: host,
                }],
                layout: LayoutNode::Leaf { pane: key },
            }],
        };
        db.save_workspace(&layout).expect("save");
        let saved = db.load_workspace().expect("load").expect("layout");
        assert_eq!(
            serde_json::to_value(&saved).expect("saved"),
            serde_json::to_value(&layout).expect("original")
        );
        layout.tabs[0].layout = LayoutNode::Leaf {
            pane: uuid::Uuid::new_v4().to_string(),
        };
        assert!(db.save_workspace(&layout).is_err());
    }
}
