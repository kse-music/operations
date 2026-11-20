use super::{Database, decode_error, storage_error};
use rusqlite::{Connection, TransactionBehavior, params};
use serverdeck_core::{
    Error,
    hosts::{
        EnvironmentTag, EnvironmentTagColor, EnvironmentTagInput, EnvironmentTags,
        normalize_environment_tag_name,
    },
};
use uuid::Uuid;

pub(super) fn read(connection: &Connection) -> Result<EnvironmentTags, Error> {
    let tags = connection
        .prepare("SELECT id,name,color FROM host_environment_tags ORDER BY rowid")
        .map_err(storage_error)?
        .query_map([], |row| {
            Ok(EnvironmentTag {
                id: row.get(0)?,
                name: row.get(1)?,
                color: EnvironmentTagColor::parse(&row.get::<_, String>(2)?)
                    .map_err(decode_error)?,
            })
        })
        .map_err(storage_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(storage_error)?;
    let assignments = connection
        .prepare("SELECT host_id,tag_id FROM host_environment_assignments")
        .map_err(storage_error)?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .map_err(storage_error)?
        .collect::<rusqlite::Result<_>>()
        .map_err(storage_error)?;
    Ok(EnvironmentTags { tags, assignments })
}

impl Database {
    fn change_environment_tags(
        &self,
        change: impl FnOnce(&Connection) -> Result<(), Error>,
    ) -> Result<EnvironmentTags, Error> {
        let mut connection = self.connect()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        change(&tx)?;
        let result = read(&tx)?;
        tx.commit().map_err(storage_error)?;
        Ok(result)
    }

    pub fn environment_tag_save(
        &self,
        id: Option<&str>,
        input: EnvironmentTagInput,
    ) -> Result<EnvironmentTags, Error> {
        let name = normalize_environment_tag_name(&input.name)?;
        self.change_environment_tags(|tx| {
            let duplicate: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM host_environment_tags
                        WHERE name=?1 AND id IS NOT ?2)",
                    params![name, id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if duplicate {
                return Err(Error::Validation("已有同名环境标签"));
            }
            if let Some(id) = id {
                let count = tx
                    .execute(
                        "UPDATE host_environment_tags SET name=?2,color=?3 WHERE id=?1",
                        params![id, name, input.color.as_str()],
                    )
                    .map_err(storage_error)?;
                if count == 0 {
                    return Err(Error::NotFound);
                }
            } else {
                tx.execute(
                    "INSERT INTO host_environment_tags(id,name,color) VALUES(?1,?2,?3)",
                    params![Uuid::new_v4().to_string(), name, input.color.as_str()],
                )
                .map_err(storage_error)?;
            }
            Ok(())
        })
    }

    pub fn environment_tag_delete(&self, id: &str) -> Result<EnvironmentTags, Error> {
        self.change_environment_tags(|tx| {
            let count = tx
                .execute("DELETE FROM host_environment_tags WHERE id=?1", [id])
                .map_err(storage_error)?;
            if count == 0 {
                return Err(Error::NotFound);
            }
            Ok(())
        })
    }

    pub fn host_set_environment_tag(
        &self,
        host_id: &str,
        tag_id: Option<&str>,
    ) -> Result<EnvironmentTags, Error> {
        self.change_environment_tags(|tx| {
            let host_exists: bool = tx
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM hosts WHERE id=?1)",
                    [host_id],
                    |row| row.get(0),
                )
                .map_err(storage_error)?;
            if !host_exists {
                return Err(Error::NotFound);
            }
            if let Some(tag_id) = tag_id {
                let count = tx
                    .execute(
                        "INSERT INTO host_environment_assignments(host_id,tag_id)
                         SELECT ?1,id FROM host_environment_tags WHERE id=?2
                         ON CONFLICT(host_id) DO UPDATE SET tag_id=excluded.tag_id",
                        params![host_id, tag_id],
                    )
                    .map_err(storage_error)?;
                if count == 0 {
                    return Err(Error::NotFound);
                }
            } else {
                tx.execute(
                    "DELETE FROM host_environment_assignments WHERE host_id=?1",
                    [host_id],
                )
                .map_err(storage_error)?;
            }
            Ok(())
        })
    }
}
