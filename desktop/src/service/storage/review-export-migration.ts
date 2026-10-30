// Append-only v11; all prior migration text/checksums remain unchanged.
export const reviewExportMigration = `
CREATE TABLE path_review_versions (
 project_id TEXT NOT NULL, run_id TEXT NOT NULL, path_id TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0),
 status TEXT NOT NULL CHECK(status IN ('unreviewed','confirmed','false_positive','needs_more_info')),
 note TEXT NOT NULL CHECK(length(note)<=6000),
 baseline_json TEXT NOT NULL CHECK(json_valid(baseline_json)), saved_at TEXT NOT NULL,
 PRIMARY KEY(project_id,run_id,path_id,revision),
 FOREIGN KEY(path_id,run_id,project_id) REFERENCES call_paths(path_id,run_id,project_id)
) STRICT;
CREATE TRIGGER immutable_path_review_versions_update BEFORE UPDATE ON path_review_versions
 BEGIN SELECT RAISE(ABORT,'review versions are immutable'); END;
CREATE TRIGGER immutable_path_review_versions_delete BEFORE DELETE ON path_review_versions
 BEGIN SELECT RAISE(ABORT,'review versions are immutable'); END;
ALTER TABLE reports ADD COLUMN format TEXT NOT NULL DEFAULT 'html' CHECK(format IN ('html','json'));
ALTER TABLE reports ADD COLUMN filter_json TEXT NOT NULL DEFAULT '{"verdict":"all","pathStatus":"all","reviewStatus":"all"}' CHECK(json_valid(filter_json));
`
