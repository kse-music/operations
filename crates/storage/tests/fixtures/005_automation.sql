CREATE TABLE automation_groups (
 id TEXT PRIMARY KEY NOT NULL,
 name TEXT NOT NULL UNIQUE COLLATE NOCASE
) STRICT;
CREATE TABLE automation_entries (
 id TEXT PRIMARY KEY NOT NULL,
 revision INTEGER NOT NULL,
 group_id TEXT REFERENCES automation_groups(id) ON DELETE SET NULL,
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE TABLE automation_schedules (
 id TEXT PRIMARY KEY NOT NULL,
 entry_id TEXT NOT NULL REFERENCES automation_entries(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL,
 enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
 next_at INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document))
) STRICT;
CREATE INDEX automation_due ON automation_schedules(enabled,next_at);
CREATE TABLE automation_runs (
 id TEXT PRIMARY KEY NOT NULL,
 entry_name TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('Pending','Running','Success','Failed','Cancelled','Unknown')),
 approval_required INTEGER NOT NULL,
 trigger TEXT NOT NULL,
 schedule_id TEXT,
 scheduled_for INTEGER,
 created_at INTEGER NOT NULL,
 finished_at INTEGER,
 targets INTEGER NOT NULL,
 message TEXT,
 revision INTEGER NOT NULL,
 document TEXT NOT NULL CHECK(json_valid(document)),
 UNIQUE(schedule_id,scheduled_for)
) STRICT;
CREATE INDEX automation_history ON automation_runs(created_at DESC,id DESC);

CREATE INDEX automation_run_state ON automation_runs(state,created_at DESC,id DESC);
CREATE INDEX automation_schedule_history ON automation_runs(schedule_id,created_at DESC,id DESC);
