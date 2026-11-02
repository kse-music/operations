CREATE TABLE hosts_optional_name (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 0 AND 128),
  hostname TEXT NOT NULL,
  port INTEGER NOT NULL CHECK(port BETWEEN 1 AND 65535),
  username TEXT NOT NULL,
  auth_type TEXT NOT NULL CHECK(auth_type IN ('password', 'private_key', 'agent')),
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,
  group_id TEXT REFERENCES host_groups(id) ON DELETE SET NULL,
  tags TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(tags) AND json_type(tags) = 'array'),
  description TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
  connect_timeout_secs INTEGER NOT NULL CHECK(connect_timeout_secs BETWEEN 1 AND 120),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ssh_options TEXT NOT NULL DEFAULT '{}',
  CHECK(auth_type != 'agent' OR credential_id IS NULL)
) STRICT;
INSERT INTO hosts_optional_name (
  id, name, hostname, port, username, auth_type, credential_id, group_id, tags,
  description, favorite, connect_timeout_secs, created_at, updated_at, ssh_options
)
SELECT id, name, hostname, port, username, auth_type, credential_id, group_id, tags,
  description, favorite, connect_timeout_secs, created_at, updated_at, ssh_options
FROM hosts;
DROP TABLE hosts;
ALTER TABLE hosts_optional_name RENAME TO hosts;
CREATE INDEX hosts_group ON hosts(group_id);
CREATE INDEX hosts_credential ON hosts(credential_id);
CREATE INDEX hosts_endpoint ON hosts(hostname, port, username);
