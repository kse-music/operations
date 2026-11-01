CREATE TABLE ssh_known_hosts (
    hostname TEXT NOT NULL,
    port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
    public_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    trusted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (hostname, port)
);
