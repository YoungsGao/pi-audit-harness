-- schema v15, fresh structural export, 2026-11-12. Use application migrations for upgrades.
PRAGMA foreign_keys=ON;

CREATE TABLE analysis_sessions (
 session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, chain_id TEXT NOT NULL,
 attempt_id INTEGER NOT NULL CHECK(attempt_id>0), model_config_id TEXT NOT NULL REFERENCES model_configs(id),
 state TEXT NOT NULL CHECK(state IN ('queue','analyze','completed','error','timeout','stop','cancel')),
 min_event_id INTEGER NOT NULL DEFAULT 1 CHECK(min_event_id>0), created_at TEXT NOT NULL, finished_at TEXT, error_code TEXT,
 UNIQUE(chain_id,attempt_id), FOREIGN KEY(chain_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;

CREATE INDEX idx_sessions_path ON analysis_sessions(run_id,chain_id,attempt_id);

CREATE TABLE audit_events (
 event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, chain_id TEXT,
 seq INTEGER, time TEXT NOT NULL, type TEXT NOT NULL, summary TEXT, summary_missing INTEGER NOT NULL,
 tool_call_id TEXT,tool_name TEXT,status TEXT NOT NULL,duration_ms INTEGER,truncated INTEGER NOT NULL,
 body_json TEXT NOT NULL CHECK(json_valid(body_json)),
 session_id TEXT REFERENCES analysis_sessions(session_id),session_seq INTEGER,stream_event TEXT,
 UNIQUE(run_id,seq),UNIQUE(session_id,session_seq),
 FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id),
 FOREIGN KEY(chain_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;

CREATE INDEX idx_audit_events_path ON audit_events(run_id,chain_id,seq);

CREATE TABLE audit_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  source_stamp TEXT NOT NULL, rules_version TEXT NOT NULL,
  model_config_id TEXT REFERENCES model_configs(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, stage TEXT NOT NULL DEFAULT 'prepared'
  CHECK(stage IN ('scanning','prepared','analyzing','completed','failed','interrupted')), started_at TEXT, finished_at TEXT, error_code TEXT, snapshot_id TEXT REFERENCES source_snapshots(snapshot_id), review_json TEXT CHECK(review_json IS NULL OR json_valid(review_json)), review_hash TEXT, graph_json TEXT CHECK(graph_json IS NULL OR json_valid(graph_json)), graph_hash TEXT, graph_created_at TEXT, scan_state TEXT CHECK(scan_state IN ('scanning','ready','partial','empty','failed')), candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count>=0), unresolved_calls INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_calls>=0), scan_truncated INTEGER NOT NULL DEFAULT 0 CHECK(scan_truncated IN (0,1)), warnings_json TEXT CHECK(warnings_json IS NULL OR json_valid(warnings_json)), scan_error_code TEXT, scan_started_at TEXT, scan_finished_at TEXT, control_state TEXT NOT NULL DEFAULT 'idle' CHECK(control_state IN ('idle','running','stop_requested','waiting_external','stopped','interrupted','completed')), control_revision INTEGER NOT NULL DEFAULT 0 CHECK(control_revision>=0), control_updated_at TEXT, model_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(model_json)),
  UNIQUE(id, project_id)
) STRICT;

CREATE INDEX idx_runs_model ON audit_runs(model_config_id);

CREATE INDEX idx_runs_project ON audit_runs(project_id, created_at);

CREATE TRIGGER frozen_run_inputs BEFORE UPDATE OF snapshot_id,review_json,review_hash,graph_json,graph_hash ON audit_runs
WHEN (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS NOT OLD.snapshot_id)
 OR (OLD.review_json IS NOT NULL AND (NEW.review_json IS NOT OLD.review_json OR NEW.review_hash IS NOT OLD.review_hash))
 OR (OLD.graph_json IS NOT NULL AND (NEW.graph_json IS NOT OLD.graph_json OR NEW.graph_hash IS NOT OLD.graph_hash))
BEGIN SELECT RAISE(ABORT,'run inputs are frozen'); END;

CREATE TRIGGER run_snapshot_insert_scope BEFORE INSERT ON audit_runs
WHEN NEW.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_snapshots WHERE snapshot_id=NEW.snapshot_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'snapshot project mismatch'); END;

CREATE TRIGGER run_snapshot_scope BEFORE UPDATE OF snapshot_id,project_id ON audit_runs
WHEN NEW.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_snapshots WHERE snapshot_id=NEW.snapshot_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'snapshot project mismatch'); END;

CREATE TABLE audit_template_versions (
  template_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  name TEXT NOT NULL, language TEXT NOT NULL CHECK(language='java'), category TEXT NOT NULL,
  description TEXT NOT NULL, markdown TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('manual','markdown','skill')), source_name TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY(template_id,revision)
) STRICT;

CREATE TRIGGER immutable_audit_template_versions_delete BEFORE DELETE ON audit_template_versions
   BEGIN SELECT RAISE(ABORT,'immutable audit configuration'); END;

CREATE TRIGGER immutable_audit_template_versions_update BEFORE UPDATE ON audit_template_versions
   BEGIN SELECT RAISE(ABORT,'immutable audit configuration'); END;

CREATE TABLE call_edges (
  uid TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  file_path TEXT NOT NULL, caller_key TEXT NOT NULL, callee_key TEXT NOT NULL,
  call_line INTEGER NOT NULL CHECK(call_line >= 1),
  is_sink INTEGER NOT NULL CHECK(is_sink IN (0,1)), rule_id TEXT, file_name TEXT NOT NULL DEFAULT '', function_name TEXT NOT NULL DEFAULT '', called_function_name TEXT NOT NULL DEFAULT '', called_function_file_name TEXT, called_function_file_path TEXT, call_column INTEGER NOT NULL DEFAULT 1 CHECK(call_column>=1), resolution_status TEXT NOT NULL DEFAULT 'unresolved'
  CHECK(resolution_status IN ('candidate','confirmed','unresolved','invalid')), arguments_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(arguments_json) AND json_type(arguments_json)='array'),
  UNIQUE(uid, run_id, project_id),
  FOREIGN KEY(run_id, project_id) REFERENCES audit_runs(id, project_id)
) STRICT;

CREATE INDEX idx_edges_location ON call_edges(run_id,file_path,call_line,call_column);

CREATE INDEX idx_edges_run ON call_edges(run_id, project_id);

CREATE TABLE call_paths (
  path_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  path_hash TEXT NOT NULL, sink_edge_id TEXT,
  verdict TEXT NOT NULL CHECK(verdict IN ('unknown','safe','dangerous')),
  dangerous INTEGER CHECK(dangerous IN (0,1)),
  result_summary TEXT NOT NULL, created_at TEXT NOT NULL, source_ref TEXT, rule_id TEXT, status TEXT NOT NULL DEFAULT 'pending'
  CHECK(status IN ('pending','analyzing','completed','failed','unresolved','invalid')), truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1)), truncation_reason TEXT NOT NULL DEFAULT ''
  CHECK((truncated=0 AND truncation_reason='') OR (truncated=1 AND length(truncation_reason)>0)), updated_at TEXT NOT NULL DEFAULT '', manual_points_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(manual_points_json)),
  CHECK((verdict = 'unknown' AND dangerous IS NULL) OR
        (verdict = 'safe' AND dangerous IS NOT NULL AND dangerous = 0) OR
        (verdict = 'dangerous' AND dangerous IS NOT NULL AND dangerous = 1)),
  UNIQUE(run_id, path_hash), UNIQUE(path_id, run_id, project_id),
  FOREIGN KEY(run_id, project_id) REFERENCES audit_runs(id, project_id),
  FOREIGN KEY(sink_edge_id, run_id, project_id) REFERENCES call_edges(uid, run_id, project_id)
) STRICT;

CREATE INDEX idx_paths_work_queue ON call_paths(run_id,status,created_at,path_id);

CREATE INDEX idx_paths_sink ON call_paths(sink_edge_id, run_id, project_id);

CREATE INDEX idx_paths_run ON call_paths(run_id, project_id);

CREATE TABLE credential_cleanup (
  secret_ref TEXT PRIMARY KEY, created_at TEXT NOT NULL
) STRICT;

CREATE TABLE disclosure_grants (
  scope_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), confirmed_at TEXT NOT NULL,
  FOREIGN KEY(snapshot_id,project_id) REFERENCES source_snapshots(snapshot_id,project_id)
) STRICT;

CREATE TRIGGER immutable_disclosure_grants_delete BEFORE DELETE ON disclosure_grants
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;

CREATE TRIGGER immutable_disclosure_grants_update BEFORE UPDATE ON disclosure_grants
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;

CREATE TABLE model_configs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  model_id TEXT NOT NULL, secret_ref TEXT, revision INTEGER NOT NULL CHECK(revision > 0)
, api TEXT NOT NULL DEFAULT 'openai-completions'
  CHECK(api = 'openai-completions'), created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT '') STRICT;

CREATE UNIQUE INDEX idx_models_secret_ref ON model_configs(secret_ref) WHERE secret_ref IS NOT NULL;

CREATE TABLE model_requests (
 request_id TEXT PRIMARY KEY,journey_id TEXT,path_id TEXT NOT NULL,run_id TEXT NOT NULL,project_id TEXT NOT NULL,
 epoch INTEGER,attempt INTEGER,state TEXT NOT NULL CHECK(state IN ('authorized','started','received','uncertain')),
 usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),started_at TEXT NOT NULL,finished_at TEXT,
 scope_key TEXT REFERENCES disclosure_grants(scope_key),config_id TEXT,revision INTEGER,base_url TEXT,model_id TEXT,observed_model_id TEXT,
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;

CREATE INDEX idx_model_requests_run ON model_requests(run_id,path_id);

CREATE INDEX idx_model_requests_journey ON model_requests(journey_id,state);

CREATE TABLE model_selection (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  config_id TEXT REFERENCES model_configs(id),
  revision INTEGER NOT NULL CHECK(revision>=0)
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

CREATE TABLE path_review_versions (
 project_id TEXT NOT NULL, run_id TEXT NOT NULL, path_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('unreviewed','confirmed','false_positive','needs_more_info')),
 note TEXT NOT NULL CHECK(length(note)<=6000),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)), saved_at TEXT NOT NULL,
 PRIMARY KEY(project_id,run_id,path_id,revision),
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;

CREATE TRIGGER immutable_path_review_versions_delete BEFORE DELETE ON path_review_versions
 BEGIN SELECT RAISE(ABORT,'review versions are immutable'); END;

CREATE TRIGGER immutable_path_review_versions_update BEFORE UPDATE ON path_review_versions
 BEGIN SELECT RAISE(ABORT,'review versions are immutable'); END;

CREATE TABLE path_steps (
  path_id TEXT NOT NULL, step_index INTEGER NOT NULL CHECK(step_index >= 0),
  edge_uid TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, dangerous INTEGER CHECK(dangerous IN (0,1)), taint_in_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(taint_in_json) AND json_type(taint_in_json)='array'), taint_out_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(taint_out_json) AND json_type(taint_out_json)='array'), evidence_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array'), defense_summary TEXT NOT NULL DEFAULT '', propagation_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(propagation_json)),
  PRIMARY KEY(path_id, step_index),
  FOREIGN KEY(path_id, run_id, project_id) REFERENCES call_paths(path_id, run_id, project_id),
  FOREIGN KEY(edge_uid, run_id, project_id) REFERENCES call_edges(uid, run_id, project_id)
) STRICT;

CREATE INDEX idx_steps_edge ON path_steps(edge_uid, run_id, project_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  path TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('local','git')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
, git_url TEXT, git_commit TEXT, git_dirty INTEGER CHECK(git_dirty IN (0,1)), revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0), source_key TEXT, source_stamp TEXT, file_count INTEGER CHECK(file_count>0), total_bytes INTEGER CHECK(total_bytes>=0), registered_at TEXT, review_json TEXT CHECK(review_json IS NULL OR json_valid(review_json))) STRICT;

CREATE INDEX idx_projects_source ON projects(source_key,registered_at) WHERE source_key IS NOT NULL;

CREATE TRIGGER validate_git_project_insert BEFORE INSERT ON projects
WHEN NEW.source_type='git' AND (NEW.git_url IS NULL OR NEW.git_url='' OR
 NEW.git_commit IS NULL OR length(NEW.git_commit) NOT IN (40,64) OR NEW.git_dirty IS NULL)
BEGIN SELECT RAISE(ABORT,'git metadata required'); END;

CREATE TRIGGER validate_git_project_update BEFORE UPDATE OF source_type,git_url,git_commit,git_dirty ON projects
WHEN NEW.source_type='git' AND (NEW.git_url IS NULL OR NEW.git_url='' OR
 NEW.git_commit IS NULL OR length(NEW.git_commit) NOT IN (40,64) OR NEW.git_dirty IS NULL)
BEGIN SELECT RAISE(ABORT,'git metadata required'); END;

CREATE TABLE recovery_checkpoints (
 checkpoint_id TEXT PRIMARY KEY, path_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
 journey_id TEXT NOT NULL, epoch INTEGER NOT NULL, attempt INTEGER NOT NULL,
 binding_hash TEXT NOT NULL, pi_session_id TEXT NOT NULL, leaf_id TEXT NOT NULL,
 file_name TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
 host_json TEXT NOT NULL CHECK(json_valid(host_json)), created_at TEXT NOT NULL,
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;

CREATE INDEX idx_recovery_checkpoints_path ON recovery_checkpoints(path_id,created_at);

CREATE TRIGGER immutable_recovery_checkpoints_delete BEFORE DELETE ON recovery_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoints are immutable'); END;

CREATE TRIGGER immutable_recovery_checkpoints_update BEFORE UPDATE ON recovery_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoints are immutable'); END;

CREATE TABLE reports (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  file_path TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  summary TEXT NOT NULL, created_at TEXT NOT NULL, summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json)), generated_at TEXT, error_message TEXT, format TEXT NOT NULL DEFAULT 'html' CHECK(format IN ('html','json')), filter_json TEXT NOT NULL DEFAULT '{"verdict":"all","pathStatus":"all","reviewStatus":"all"}' CHECK(json_valid(filter_json)),
  FOREIGN KEY(run_id, project_id) REFERENCES audit_runs(id, project_id)
) STRICT;

CREATE INDEX idx_reports_run ON reports(run_id, project_id);

CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    ) STRICT;

CREATE TABLE snapshot_files (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  file_path TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  content BLOB NOT NULL, PRIMARY KEY(snapshot_id,file_path)
) STRICT;

CREATE TRIGGER immutable_snapshot_files_delete BEFORE DELETE ON snapshot_files
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;

CREATE TRIGGER immutable_snapshot_files_update BEFORE UPDATE ON snapshot_files
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;

CREATE TABLE source_snapshots (
  snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  source_stamp TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  ignored_json TEXT NOT NULL CHECK(json_valid(ignored_json)),
  source_commit TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id,source_stamp), UNIQUE(snapshot_id,project_id)
) STRICT;

CREATE TRIGGER immutable_source_snapshots_delete BEFORE DELETE ON source_snapshots
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;

CREATE TRIGGER immutable_source_snapshots_update BEFORE UPDATE ON source_snapshots
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;

CREATE TABLE tool_receipts (
 journey_id TEXT NOT NULL,request_key TEXT NOT NULL,tool_name TEXT NOT NULL,step_index INTEGER,
 path_id TEXT NOT NULL,run_id TEXT NOT NULL,project_id TEXT NOT NULL,binding_hash TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),sha256 TEXT NOT NULL,epoch INTEGER,saved_at TEXT NOT NULL,
 PRIMARY KEY(journey_id,request_key),
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;

CREATE TRIGGER immutable_tool_receipts_delete BEFORE DELETE ON tool_receipts BEGIN SELECT RAISE(ABORT,'tool receipts are immutable'); END;

CREATE TRIGGER immutable_tool_receipts_update BEFORE UPDATE ON tool_receipts BEGIN SELECT RAISE(ABORT,'tool receipts are immutable'); END;
