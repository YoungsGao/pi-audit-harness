export const streamMigration = `
ALTER TABLE path_steps ADD COLUMN propagation_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(propagation_json));
CREATE TABLE analysis_sessions (
 session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, chain_id TEXT NOT NULL,
 attempt_id INTEGER NOT NULL CHECK(attempt_id>0), model_config_id TEXT NOT NULL REFERENCES model_configs(id),
 state TEXT NOT NULL CHECK(state IN ('queue','analyze','completed','error','timeout','stop','cancel')),
 min_event_id INTEGER NOT NULL DEFAULT 1 CHECK(min_event_id>0), created_at TEXT NOT NULL, finished_at TEXT,
 UNIQUE(chain_id,attempt_id), FOREIGN KEY(chain_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE TABLE stream_events (
 session_id TEXT NOT NULL REFERENCES analysis_sessions(session_id), id INTEGER NOT NULL CHECK(id>0),
 event TEXT NOT NULL, data_json TEXT NOT NULL CHECK(json_valid(data_json)), created_at TEXT NOT NULL,
 PRIMARY KEY(session_id,id)
) STRICT;
CREATE INDEX idx_sessions_path ON analysis_sessions(run_id,chain_id,attempt_id);
`
