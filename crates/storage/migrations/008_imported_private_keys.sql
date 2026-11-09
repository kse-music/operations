CREATE TABLE credentials_imported_keys (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK(kind IN ('password', 'private_key')),
  key_path TEXT,
  secret_ref TEXT UNIQUE,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  CHECK((kind = 'password' AND key_path IS NULL AND secret_ref IS NOT NULL)
     OR (kind = 'private_key' AND (
         (key_path IS NOT NULL AND length(key_path) > 0)
         OR (key_path IS NULL AND secret_ref IS NOT NULL))))
) STRICT;
INSERT INTO credentials_imported_keys (id, name, kind, key_path, secret_ref, revision)
SELECT id, name, kind, key_path, secret_ref, revision FROM credentials;
DROP TABLE credentials;
ALTER TABLE credentials_imported_keys RENAME TO credentials;
