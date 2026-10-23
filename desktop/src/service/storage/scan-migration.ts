export const scanMigration = `
CREATE TABLE scan_runs (
  run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('scanning','ready','partial','empty','failed')),
  candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count>=0),
  unresolved_calls INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_calls>=0),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)),
  warnings_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(warnings_json)),
  error_code TEXT, started_at TEXT NOT NULL, finished_at TEXT,
  FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id)
) STRICT;
CREATE INDEX idx_scan_project ON scan_runs(project_id,started_at DESC);
CREATE TABLE path_attempts (
  path_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK(attempt>0), model_config_id TEXT NOT NULL REFERENCES model_configs(id),
  phase TEXT NOT NULL CHECK(phase IN ('analyzing','completed','failed')),
  started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT,
  FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
`
