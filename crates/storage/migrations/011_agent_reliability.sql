CREATE TABLE plugin_mcp_servers (
    plugin TEXT NOT NULL,
    id TEXT NOT NULL,
    revision TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    protocol TEXT NOT NULL,
    allow_http INTEGER NOT NULL CHECK(allow_http IN (0,1)),
    secret_ref TEXT,
    PRIMARY KEY(plugin,id)
) STRICT;
CREATE TABLE plugin_agent_tasks (
    plugin TEXT NOT NULL,
    id TEXT NOT NULL,
    revision TEXT NOT NULL,
    run_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    model_id TEXT NOT NULL,
    host_ids TEXT NOT NULL,
    tools TEXT NOT NULL,
    status TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    pending INTEGER NOT NULL DEFAULT 0 CHECK(pending IN (0,1)),
    uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)),
    PRIMARY KEY(plugin,id)
) STRICT;
CREATE INDEX plugin_agent_tasks_recent ON plugin_agent_tasks(plugin,updated_at DESC,id);
CREATE TABLE plugin_agent_audit (
    seq INTEGER PRIMARY KEY,
    plugin TEXT NOT NULL,
    task_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    outcome TEXT NOT NULL,
    at INTEGER NOT NULL,
    FOREIGN KEY(plugin,task_id) REFERENCES plugin_agent_tasks(plugin,id)
) STRICT;
CREATE INDEX plugin_agent_audit_task ON plugin_agent_audit(plugin,task_id,seq);
