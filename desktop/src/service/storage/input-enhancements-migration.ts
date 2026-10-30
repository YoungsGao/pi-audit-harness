export const inputEnhancementsMigration = `
CREATE TABLE source_snapshots (
  snapshot_id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  source_stamp TEXT NOT NULL, manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
  ignored_json TEXT NOT NULL CHECK(json_valid(ignored_json)),
  source_commit TEXT, created_at TEXT NOT NULL,
  UNIQUE(project_id,source_stamp), UNIQUE(snapshot_id,project_id)
) STRICT;
CREATE TABLE snapshot_files (
  snapshot_id TEXT NOT NULL REFERENCES source_snapshots(snapshot_id),
  file_path TEXT NOT NULL, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
  content BLOB NOT NULL, PRIMARY KEY(snapshot_id,file_path)
) STRICT;
CREATE TABLE run_snapshots (
  run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id),
  FOREIGN KEY(snapshot_id,project_id) REFERENCES source_snapshots(snapshot_id,project_id)
) STRICT;
CREATE TABLE disclosure_grants (
  scope_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, snapshot_id TEXT NOT NULL,
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)), confirmed_at TEXT NOT NULL,
  FOREIGN KEY(snapshot_id,project_id) REFERENCES source_snapshots(snapshot_id,project_id)
) STRICT;
CREATE TABLE source_transmissions (
  transmission_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  path_id TEXT NOT NULL, attempt INTEGER NOT NULL, scope_key TEXT NOT NULL REFERENCES disclosure_grants(scope_key),
  config_id TEXT NOT NULL, revision INTEGER NOT NULL, base_url TEXT NOT NULL,
  model_id TEXT NOT NULL, observed_model_id TEXT, started_at TEXT NOT NULL,
  FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE TABLE manual_risk_points (
  point_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, run_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, path_id TEXT NOT NULL, file_path TEXT NOT NULL,
  line INTEGER NOT NULL CHECK(line>0), column_number INTEGER NOT NULL CHECK(column_number>0),
  function_key TEXT, rule_id TEXT NOT NULL, note TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE(run_id,file_path,line,column_number,path_id),
  FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id),
  FOREIGN KEY(snapshot_id,project_id) REFERENCES source_snapshots(snapshot_id,project_id)
) STRICT;
${['source_snapshots', 'snapshot_files', 'run_snapshots', 'disclosure_grants', 'manual_risk_points']
  .flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (op) =>
        `CREATE TRIGGER immutable_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table}
     BEGIN SELECT RAISE(ABORT,'immutable source record'); END;`
    )
  )
  .join('\n')}
`
