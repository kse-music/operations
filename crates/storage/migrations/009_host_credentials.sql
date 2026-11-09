ALTER TABLE credentials ADD COLUMN host_managed INTEGER NOT NULL DEFAULT 0
  CHECK(host_managed IN (0, 1));
