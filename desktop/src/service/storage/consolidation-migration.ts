// v1–v14 remain unchanged: deployed databases upgrade atomically to this layout.
export const consolidationMigration = `
-- Project registration and review settings are attributes of a project.
DROP TRIGGER validate_git_project_update;
CREATE TRIGGER validate_git_project_update BEFORE UPDATE OF source_type,git_url,git_commit,git_dirty ON projects
WHEN NEW.source_type='git' AND (NEW.git_url IS NULL OR NEW.git_url='' OR
 NEW.git_commit IS NULL OR length(NEW.git_commit) NOT IN (40,64) OR NEW.git_dirty IS NULL)
BEGIN SELECT RAISE(ABORT,'git metadata required'); END;
ALTER TABLE projects ADD COLUMN source_key TEXT;
ALTER TABLE projects ADD COLUMN source_stamp TEXT;
ALTER TABLE projects ADD COLUMN file_count INTEGER CHECK(file_count>0);
ALTER TABLE projects ADD COLUMN total_bytes INTEGER CHECK(total_bytes>=0);
ALTER TABLE projects ADD COLUMN registered_at TEXT;
ALTER TABLE projects ADD COLUMN review_json TEXT CHECK(review_json IS NULL OR json_valid(review_json));
UPDATE projects SET (source_key,source_stamp,file_count,total_bytes,registered_at)=
 (SELECT source_key,source_stamp,file_count,total_bytes,registered_at FROM source_imports WHERE project_id=projects.id)
 WHERE id IN (SELECT project_id FROM source_imports);
UPDATE projects SET review_json=(SELECT json_object('projectId',project_id,'revision',revision,
 'businessWrappers',business_wrappers,'inputSources',input_sources,'defenseConventions',defense_conventions,
 'focus',focus,'updatedAt',updated_at) FROM project_review_settings WHERE project_id=projects.id)
 WHERE id IN (SELECT project_id FROM project_review_settings);
CREATE INDEX idx_projects_source ON projects(source_key,registered_at) WHERE source_key IS NOT NULL;

-- Run-owned, one-to-one rows become columns on their owner.
ALTER TABLE audit_runs ADD COLUMN snapshot_id TEXT REFERENCES source_snapshots(snapshot_id);
ALTER TABLE audit_runs ADD COLUMN review_json TEXT CHECK(review_json IS NULL OR json_valid(review_json));
ALTER TABLE audit_runs ADD COLUMN review_hash TEXT;
ALTER TABLE audit_runs ADD COLUMN graph_json TEXT CHECK(graph_json IS NULL OR json_valid(graph_json));
ALTER TABLE audit_runs ADD COLUMN graph_hash TEXT;
ALTER TABLE audit_runs ADD COLUMN graph_created_at TEXT;
ALTER TABLE audit_runs ADD COLUMN scan_state TEXT CHECK(scan_state IN ('scanning','ready','partial','empty','failed'));
ALTER TABLE audit_runs ADD COLUMN candidate_count INTEGER NOT NULL DEFAULT 0 CHECK(candidate_count>=0);
ALTER TABLE audit_runs ADD COLUMN unresolved_calls INTEGER NOT NULL DEFAULT 0 CHECK(unresolved_calls>=0);
ALTER TABLE audit_runs ADD COLUMN scan_truncated INTEGER NOT NULL DEFAULT 0 CHECK(scan_truncated IN (0,1));
ALTER TABLE audit_runs ADD COLUMN warnings_json TEXT CHECK(warnings_json IS NULL OR json_valid(warnings_json));
ALTER TABLE audit_runs ADD COLUMN scan_error_code TEXT;
ALTER TABLE audit_runs ADD COLUMN scan_started_at TEXT;
ALTER TABLE audit_runs ADD COLUMN scan_finished_at TEXT;
ALTER TABLE audit_runs ADD COLUMN control_state TEXT NOT NULL DEFAULT 'idle' CHECK(control_state IN ('idle','running','stop_requested','waiting_external','stopped','interrupted','completed'));
ALTER TABLE audit_runs ADD COLUMN control_revision INTEGER NOT NULL DEFAULT 0 CHECK(control_revision>=0);
ALTER TABLE audit_runs ADD COLUMN control_updated_at TEXT;
ALTER TABLE audit_runs ADD COLUMN model_json TEXT NOT NULL DEFAULT 'null' CHECK(json_valid(model_json));
UPDATE audit_runs SET snapshot_id=(SELECT snapshot_id FROM run_snapshots WHERE run_id=audit_runs.id);
UPDATE audit_runs SET (review_json,review_hash)=(SELECT context_json,context_hash FROM run_review_configs WHERE run_id=audit_runs.id);
UPDATE audit_runs SET (graph_json,graph_hash,graph_created_at)=(SELECT binding_json,binding_hash,created_at FROM run_graph_bindings WHERE run_id=audit_runs.id);
UPDATE audit_runs SET (scan_state,candidate_count,unresolved_calls,scan_truncated,warnings_json,scan_error_code,scan_started_at,scan_finished_at)=
 (SELECT state,candidate_count,unresolved_calls,truncated,warnings_json,error_code,started_at,finished_at FROM scan_runs WHERE run_id=audit_runs.id)
 WHERE id IN (SELECT run_id FROM scan_runs);
UPDATE audit_runs SET (control_state,control_revision,control_updated_at,model_json)=
 (SELECT state,revision,updated_at,model_json FROM run_controls WHERE run_id=audit_runs.id)
 WHERE id IN (SELECT run_id FROM run_controls);
CREATE TRIGGER frozen_run_inputs BEFORE UPDATE OF snapshot_id,review_json,review_hash,graph_json,graph_hash ON audit_runs
WHEN (OLD.snapshot_id IS NOT NULL AND NEW.snapshot_id IS NOT OLD.snapshot_id)
 OR (OLD.review_json IS NOT NULL AND (NEW.review_json IS NOT OLD.review_json OR NEW.review_hash IS NOT OLD.review_hash))
 OR (OLD.graph_json IS NOT NULL AND (NEW.graph_json IS NOT OLD.graph_json OR NEW.graph_hash IS NOT OLD.graph_hash))
BEGIN SELECT RAISE(ABORT,'run inputs are frozen'); END;
CREATE TRIGGER run_snapshot_scope BEFORE UPDATE OF snapshot_id,project_id ON audit_runs
WHEN NEW.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_snapshots WHERE snapshot_id=NEW.snapshot_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'snapshot project mismatch'); END;
CREATE TRIGGER run_snapshot_insert_scope BEFORE INSERT ON audit_runs
WHEN NEW.snapshot_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM source_snapshots WHERE snapshot_id=NEW.snapshot_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'snapshot project mismatch'); END;

-- Preserve every legacy manual point, including any multiple points on a path.
ALTER TABLE call_paths ADD COLUMN manual_points_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(manual_points_json));
UPDATE call_paths SET manual_points_json=(SELECT json_group_array(json_object(
 'pointId',point_id,'snapshotId',snapshot_id,'filePath',file_path,'line',line,'column',column_number,
 'functionKey',function_key,'ruleId',rule_id,'note',note,'createdAt',created_at))
 FROM manual_risk_points WHERE path_id=call_paths.path_id);

-- A session already represents an attempt; keep its ID and its historical state.
ALTER TABLE analysis_sessions ADD COLUMN error_code TEXT;
UPDATE analysis_sessions SET error_code=(SELECT error_code FROM path_attempts a WHERE a.path_id=chain_id AND a.attempt=attempt_id);
-- Very old/partial databases can have attempts without a stream session.
INSERT INTO analysis_sessions(session_id,run_id,project_id,chain_id,attempt_id,model_config_id,state,created_at,finished_at,error_code)
 SELECT 'legacy-attempt-'||a.path_id||'-'||a.attempt,a.run_id,a.project_id,a.path_id,a.attempt,a.model_config_id,
 CASE a.phase WHEN 'analyzing' THEN 'analyze' WHEN 'completed' THEN 'completed' ELSE 'error' END,
 a.started_at,a.finished_at,a.error_code FROM path_attempts a
 WHERE NOT EXISTS(SELECT 1 FROM analysis_sessions s WHERE s.chain_id=a.path_id AND s.attempt_id=a.attempt);

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
-- Pair only exact payload/summary matches, in order. Never guess an old cursor.
CREATE TEMP TABLE event_pairs AS
WITH d AS (SELECT *,row_number() OVER(PARTITION BY run_id,chain_id,summary,payload_json,tool_call_id ORDER BY seq) AS occurrence FROM analysis_events),
 s AS (SELECT e.*,a.run_id,a.chain_id,json_extract(e.data_json,'$.message') AS summary,
 json_extract(e.data_json,'$.details.payload') AS payload,
 json_extract(e.data_json,'$.details.toolCallId') AS tool_call_id,
 row_number() OVER(PARTITION BY a.run_id,a.chain_id,json_extract(e.data_json,'$.message'),
 json_extract(e.data_json,'$.details.payload'),json_extract(e.data_json,'$.details.toolCallId') ORDER BY a.attempt_id,e.id) AS occurrence
 FROM stream_events e JOIN analysis_sessions a USING(session_id) WHERE e.event!='queued')
 SELECT d.event_id,s.session_id,s.id FROM d JOIN s ON d.run_id=s.run_id AND d.chain_id=s.chain_id
 AND d.summary IS s.summary AND json_extract(d.payload_json,'$') IS s.payload
 AND d.tool_call_id IS s.tool_call_id AND d.occurrence=s.occurrence
 AND s.event=CASE
 WHEN d.status='analyzing' THEN 'analyzing'
 WHEN d.type='process' AND d.status='request_retry' THEN 'request_info'
 WHEN d.type='process' AND d.status LIKE 'validation_%' THEN 'validation_info'
 WHEN d.type='tool' THEN 'tool_call_info'
 WHEN d.type='model' THEN 'thoughts_execute'
 WHEN d.type='result' THEN CASE
   WHEN d.status IN ('failed','interrupted') AND (json_extract(d.payload_json,'$.errorCode') LIKE '%TIMEOUT%' OR json_extract(d.payload_json,'$.errorCode') LIKE '%TIMED_OUT%') THEN 'timed_out'
   WHEN d.status='stopped' OR json_extract(d.payload_json,'$.errorCode') IN ('RUN_USER_STOP','AGENT_NO_PROGRESS','AGENT_ROUND_LIMIT','AGENT_TOOL_LIMIT','AGENT_REQUEST_LIMIT','AGENT_EVIDENCE_LIMIT') THEN 'stopped'
   WHEN d.status IN ('failed','interrupted') THEN 'failed' ELSE 'completed' END
 ELSE NULL END;
INSERT INTO audit_events
 SELECT d.event_id,d.run_id,d.project_id,d.chain_id,d.seq,d.time,d.type,d.summary,d.summary_missing,
 d.tool_call_id,d.tool_name,d.status,d.duration_ms,d.truncated,
 COALESCE(s.data_json,json_object('payload',json(d.payload_json))),s.session_id,s.id,s.event
 FROM analysis_events d LEFT JOIN event_pairs p USING(event_id)
 LEFT JOIN stream_events s ON s.session_id=p.session_id AND s.id=p.id;
-- Queued and unmatched historical frames are retained verbatim, outside the domain cursor.
INSERT INTO audit_events
 SELECT 'legacy-stream-'||s.session_id||'-'||s.id,a.run_id,a.project_id,a.chain_id,NULL,s.created_at,
 CASE WHEN s.event IN ('completed','failed','stopped','timed_out') THEN 'result' ELSE 'process' END,
 json_extract(s.data_json,'$.message'),COALESCE(json_extract(s.data_json,'$.summaryMissing'),1),
 json_extract(s.data_json,'$.details.toolCallId'),json_extract(s.data_json,'$.details.toolName'),
 json_extract(s.data_json,'$.status'),CAST(json_extract(s.data_json,'$.details.durationMs') AS INTEGER),
 COALESCE(json_extract(s.data_json,'$.details.truncated'),0),s.data_json,s.session_id,s.id,s.event
 FROM stream_events s JOIN analysis_sessions a USING(session_id)
 WHERE NOT EXISTS(SELECT 1 FROM event_pairs p WHERE p.session_id=s.session_id AND p.id=s.id);
DROP TABLE event_pairs;
CREATE INDEX idx_audit_events_path ON audit_events(run_id,chain_id,seq);

CREATE TABLE tool_receipts (
 journey_id TEXT NOT NULL,request_key TEXT NOT NULL,tool_name TEXT NOT NULL,step_index INTEGER,
 path_id TEXT NOT NULL,run_id TEXT NOT NULL,project_id TEXT NOT NULL,binding_hash TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),sha256 TEXT NOT NULL,epoch INTEGER,saved_at TEXT NOT NULL,
 PRIMARY KEY(journey_id,request_key),
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
INSERT INTO tool_receipts SELECT journey_id,'step:'||step_index,'audit_read_step',step_index,path_id,run_id,project_id,binding_hash,evidence_json,sha256,epoch,saved_at FROM recovery_tools;
INSERT INTO tool_receipts SELECT journey_id,request_key,json_extract(receipt_json,'$.name'),NULL,path_id,run_id,project_id,binding_hash,receipt_json,sha256,NULL,saved_at FROM recovery_mcp_tools;
CREATE TRIGGER immutable_tool_receipts_update BEFORE UPDATE ON tool_receipts BEGIN SELECT RAISE(ABORT,'tool receipts are immutable'); END;
CREATE TRIGGER immutable_tool_receipts_delete BEFORE DELETE ON tool_receipts BEGIN SELECT RAISE(ABORT,'tool receipts are immutable'); END;

CREATE TABLE model_requests (
 request_id TEXT PRIMARY KEY,journey_id TEXT,path_id TEXT NOT NULL,run_id TEXT NOT NULL,project_id TEXT NOT NULL,
 epoch INTEGER,attempt INTEGER,state TEXT NOT NULL CHECK(state IN ('authorized','started','received','uncertain')),
 usage_json TEXT CHECK(usage_json IS NULL OR json_valid(usage_json)),started_at TEXT NOT NULL,finished_at TEXT,
 scope_key TEXT REFERENCES disclosure_grants(scope_key),config_id TEXT,revision INTEGER,base_url TEXT,model_id TEXT,observed_model_id TEXT,
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
-- Old ledgers had no shared identifier. Keep both facts without inventing a pairing.
INSERT INTO model_requests(request_id,journey_id,path_id,run_id,project_id,epoch,state,usage_json,started_at,finished_at)
 SELECT request_id,journey_id,path_id,run_id,project_id,epoch,state,usage_json,started_at,finished_at FROM recovery_requests;
INSERT INTO model_requests(request_id,path_id,run_id,project_id,attempt,state,started_at,scope_key,config_id,revision,base_url,model_id,observed_model_id)
 SELECT transmission_id,path_id,run_id,project_id,attempt,'authorized',started_at,scope_key,config_id,revision,base_url,model_id,observed_model_id FROM source_transmissions;
CREATE INDEX idx_model_requests_journey ON model_requests(journey_id,state);
CREATE INDEX idx_model_requests_run ON model_requests(run_id,path_id);

DROP TABLE stream_events;
DROP TABLE analysis_events;
DROP TABLE source_imports;
DROP TABLE project_review_settings;
DROP TABLE scan_runs;
DROP TABLE run_snapshots;
DROP TABLE run_review_configs;
DROP TABLE run_controls;
DROP TABLE run_graph_bindings;
DROP TABLE manual_risk_points;
DROP TABLE path_attempts;
DROP TABLE recovery_tools;
DROP TABLE recovery_mcp_tools;
DROP TABLE recovery_requests;
DROP TABLE source_transmissions;
`
