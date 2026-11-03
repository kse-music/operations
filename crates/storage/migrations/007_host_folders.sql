ALTER TABLE host_groups ADD COLUMN parent_id TEXT REFERENCES host_groups(id)
  ON DELETE SET NULL CHECK(parent_id IS NULL OR parent_id != id);
CREATE INDEX host_groups_parent ON host_groups(parent_id);
