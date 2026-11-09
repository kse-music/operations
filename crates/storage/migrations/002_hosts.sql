CREATE TABLE host_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK(length(trim(name)) BETWEEN 1 AND 128),
  sort_order INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE credentials (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('password', 'private_key')),
  key_path TEXT,
  secret_ref TEXT UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  CHECK((kind = 'password' AND key_path IS NULL AND secret_ref IS NOT NULL)
     OR (kind = 'private_key' AND key_path IS NOT NULL AND length(key_path) > 0))
) STRICT;
CREATE TABLE hosts (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 128),
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
  CHECK(auth_type != 'agent' OR credential_id IS NULL)
) STRICT;
CREATE INDEX hosts_group ON hosts(group_id);
CREATE INDEX hosts_credential ON hosts(credential_id);
CREATE INDEX hosts_endpoint ON hosts(hostname, port, username);
-- Durable non-sensitive tombstones: retry obsolete OS secret deletion after interruption/failure.
CREATE TABLE secret_gc (reference TEXT PRIMARY KEY NOT NULL) STRICT;
