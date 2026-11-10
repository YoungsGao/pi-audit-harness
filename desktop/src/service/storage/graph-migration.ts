export const graphMigration = `
CREATE TABLE run_graph_bindings (
 run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
 binding_json TEXT NOT NULL CHECK(json_valid(binding_json)), binding_hash TEXT NOT NULL,
 created_at TEXT NOT NULL,
 FOREIGN KEY(run_id,project_id) REFERENCES audit_runs(id,project_id)
) STRICT;
CREATE TRIGGER immutable_run_graph_update BEFORE UPDATE ON run_graph_bindings BEGIN SELECT RAISE(ABORT,'graph bindings are immutable'); END;
CREATE TRIGGER immutable_run_graph_delete BEFORE DELETE ON run_graph_bindings BEGIN SELECT RAISE(ABORT,'graph bindings are immutable'); END;
`
