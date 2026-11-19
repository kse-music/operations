CREATE TABLE host_environment_tags (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK(length(trim(name)) BETWEEN 1 AND 10),
  color TEXT NOT NULL CHECK(color IN ('red', 'amber', 'blue', 'green', 'violet', 'gray'))
) STRICT;

CREATE TABLE host_environment_assignments (
  host_id TEXT PRIMARY KEY NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES host_environment_tags(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX host_environment_assignments_tag ON host_environment_assignments(tag_id);

INSERT INTO host_environment_tags(id, name, color) VALUES
  ('production', '生产', 'red'),
  ('staging', '预发', 'amber'),
  ('testing', '测试', 'blue');
