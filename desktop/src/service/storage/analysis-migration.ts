// Append only: v1-v6 checksums remain unchanged.
export const analysisMigration = `
ALTER TABLE audit_runs ADD COLUMN stage TEXT NOT NULL DEFAULT 'prepared'
  CHECK(stage IN ('scanning','prepared','analyzing','completed','failed','interrupted'));
ALTER TABLE audit_runs ADD COLUMN started_at TEXT;
ALTER TABLE audit_runs ADD COLUMN finished_at TEXT;
ALTER TABLE audit_runs ADD COLUMN error_code TEXT;
UPDATE audit_runs SET stage=CASE WHEN status='running' THEN 'interrupted'
 WHEN status='failed' THEN 'failed' WHEN status='completed' THEN 'completed' ELSE 'prepared' END;
ALTER TABLE reports ADD COLUMN summary_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(summary_json));
ALTER TABLE reports ADD COLUMN generated_at TEXT;
ALTER TABLE reports ADD COLUMN error_message TEXT;
CREATE TABLE analysis_events (
 event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL, chain_id TEXT,
 seq INTEGER NOT NULL CHECK(seq>0), time TEXT NOT NULL,
 type TEXT NOT NULL CHECK(type IN ('process','model','tool','result')),
 summary TEXT, summary_missing INTEGER NOT NULL CHECK(summary_missing IN (0,1)),
 tool_call_id TEXT, tool_name TEXT, status TEXT NOT NULL,
 duration_ms INTEGER CHECK(duration_ms>=0),
 payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 truncated INTEGER NOT NULL CHECK(truncated IN (0,1)),
 UNIQUE(run_id,seq),
 FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id),
 FOREIGN KEY(chain_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE INDEX idx_events_chain ON analysis_events(run_id,chain_id,seq);
`
