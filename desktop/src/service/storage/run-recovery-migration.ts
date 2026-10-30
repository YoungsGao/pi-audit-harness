// Append-only migration. Do not edit released migrations to introduce new run states.
export const runRecoveryMigration = `
CREATE TABLE run_controls (
 run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('idle','running','stop_requested','waiting_external','stopped','interrupted','completed')),
 revision INTEGER NOT NULL CHECK(revision>=0), updated_at TEXT NOT NULL,
 model_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(model_json)),
 FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id)
) STRICT;
CREATE TABLE path_recovery (
 path_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 journey_id TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch>0), attempt INTEGER NOT NULL,
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), binding_hash TEXT NOT NULL,
 limits_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(limits_json)),
 state TEXT NOT NULL CHECK(state IN ('running','stopped','interrupted','completed','failed')),
 requests INTEGER NOT NULL DEFAULT 0, tools INTEGER NOT NULL DEFAULT 0, rounds INTEGER NOT NULL DEFAULT 0,
 receipt_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(receipt_json)),
 pi_session_id TEXT, session_file TEXT, updated_at TEXT NOT NULL,
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE TABLE recovery_checkpoints (
 checkpoint_id TEXT PRIMARY KEY, path_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 journey_id TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
 binding_hash TEXT NOT NULL, pi_session_id TEXT NOT NULL, leaf_id TEXT NOT NULL,
 file_name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
 host_json TEXT NOT NULL CHECK(json_valid(host_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE INDEX idx_recovery_checkpoints_path ON recovery_checkpoints(path_id,created_at);
CREATE TRIGGER immutable_recovery_checkpoints_update BEFORE UPDATE ON recovery_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoints are immutable'); END;
CREATE TRIGGER immutable_recovery_checkpoints_delete BEFORE DELETE ON recovery_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoints are immutable'); END;
CREATE TABLE recovery_tools (
 journey_id TEXT NOT NULL, step_index INTEGER NOT NULL CHECK(step_index>=0 AND step_index<16),
 path_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 binding_hash TEXT NOT NULL, evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)), sha256 TEXT NOT NULL,
 epoch INTEGER NOT NULL, saved_at TEXT NOT NULL,
 PRIMARY KEY(journey_id,step_index),
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE TRIGGER immutable_recovery_tools_update BEFORE UPDATE ON recovery_tools BEGIN SELECT RAISE(ABORT,'tool receipts are immutable'); END;
CREATE TRIGGER immutable_recovery_tools_delete BEFORE DELETE ON recovery_tools BEGIN SELECT RAISE(ABORT,'tool receipts are immutable'); END;
CREATE TABLE recovery_requests (
 request_id TEXT PRIMARY KEY, journey_id TEXT NOT NULL, path_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('started','received','uncertain')),
 usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)), started_at TEXT NOT NULL, finished_at TEXT,
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE INDEX idx_recovery_requests_journey ON recovery_requests(journey_id,state);
`
