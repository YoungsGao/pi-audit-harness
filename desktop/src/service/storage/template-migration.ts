export const templateMigration = `
CREATE TABLE audit_template_versions (
  template_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  name TEXT NOT NULL, language TEXT NOT NULL CHECK(language='java'), category TEXT NOT NULL,
  description TEXT NOT NULL, markdown TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('manual','markdown','skill')), source_name TEXT,
  created_at TEXT NOT NULL, PRIMARY KEY(template_id,revision)
) STRICT;
CREATE TABLE project_review_settings (
  project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL CHECK(revision>0),
  business_wrappers TEXT NOT NULL, input_sources TEXT NOT NULL, defense_conventions TEXT NOT NULL,
  focus TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE run_review_configs (
  run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  context_json TEXT NOT NULL CHECK(json_valid(context_json)), context_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id)
) STRICT;
${['audit_template_versions', 'run_review_configs']
  .flatMap((table) =>
    ['UPDATE', 'DELETE'].map(
      (op) =>
        `CREATE TRIGGER immutable_${table}_${op.toLowerCase()} BEFORE ${op} ON ${table}
   BEGIN SELECT RAISE(ABORT,'immutable audit configuration'); END;`
    )
  )
  .join('\n')}
`
