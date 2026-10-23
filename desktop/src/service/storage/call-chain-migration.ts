// 只追加 v5；已发布迁移的 SQL 和校验和保持不变。
export const callChainMigration = `
ALTER TABLE call_edges ADD COLUMN file_name TEXT NOT NULL DEFAULT '';
ALTER TABLE call_edges ADD COLUMN function_name TEXT NOT NULL DEFAULT '';
ALTER TABLE call_edges ADD COLUMN called_function_name TEXT NOT NULL DEFAULT '';
ALTER TABLE call_edges ADD COLUMN called_function_file_name TEXT;
ALTER TABLE call_edges ADD COLUMN called_function_file_path TEXT;
ALTER TABLE call_edges ADD COLUMN call_column INTEGER NOT NULL DEFAULT 1 CHECK(call_column>=1);
ALTER TABLE call_edges ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'unresolved'
  CHECK(resolution_status IN ('candidate','confirmed','unresolved','invalid'));
ALTER TABLE call_edges ADD COLUMN arguments_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(arguments_json) AND json_type(arguments_json)='array');
ALTER TABLE call_paths ADD COLUMN source_ref TEXT;
ALTER TABLE call_paths ADD COLUMN rule_id TEXT;
ALTER TABLE call_paths ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'
  CHECK(status IN ('pending','analyzing','completed','failed','unresolved','invalid'));
ALTER TABLE call_paths ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0,1));
ALTER TABLE call_paths ADD COLUMN truncation_reason TEXT NOT NULL DEFAULT ''
  CHECK((truncated=0 AND truncation_reason='') OR (truncated=1 AND length(truncation_reason)>0));
ALTER TABLE call_paths ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE call_paths SET updated_at=created_at, status=CASE
  WHEN (SELECT status FROM audit_runs WHERE id=call_paths.run_id)='completed' THEN 'completed'
  ELSE 'unresolved' END;
ALTER TABLE path_steps ADD COLUMN dangerous INTEGER CHECK(dangerous IN (0,1));
ALTER TABLE path_steps ADD COLUMN taint_in_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(taint_in_json) AND json_type(taint_in_json)='array');
ALTER TABLE path_steps ADD COLUMN taint_out_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(taint_out_json) AND json_type(taint_out_json)='array');
ALTER TABLE path_steps ADD COLUMN evidence_json TEXT NOT NULL DEFAULT '[]'
  CHECK(json_valid(evidence_json) AND json_type(evidence_json)='array');
ALTER TABLE path_steps ADD COLUMN defense_summary TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_paths_work_queue ON call_paths(run_id,status,created_at,path_id);
CREATE INDEX idx_edges_location ON call_edges(run_id,file_path,call_line,call_column);
`
