import { createHash } from 'node:crypto'
import { ApiError } from '../../shared/api-error.ts'
import { LocalDatabase } from './database.ts'
import { callChainMigration } from './call-chain-migration.ts'
import { scanMigration } from './scan-migration.ts'
import { analysisMigration } from './analysis-migration.ts'
import { streamMigration } from './stream-migration.ts'

// 十六进制 ASCII「PIAU」，用来避免把别的 SQLite 文件当成本应用数据库。
const APPLICATION_ID = 0x50494155
export interface Migration {
  version: number
  name: string
  sql: string
}
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial-storage',
    // SQL 随 TS 一起打包，不依赖打包后容易遗漏的外部 .sql 文件。
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL CHECK(length(trim(name)) > 0),
  path TEXT NOT NULL, source_type TEXT NOT NULL CHECK(source_type IN ('local','git')),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE model_configs (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL,
  model_id TEXT NOT NULL, secret_ref TEXT, revision INTEGER NOT NULL CHECK(revision > 0)
) STRICT;
CREATE TABLE audit_runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
  source_stamp TEXT NOT NULL, rules_version TEXT NOT NULL,
  model_config_id TEXT REFERENCES model_configs(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(id, project_id)
) STRICT;
CREATE TABLE call_edges (
  uid TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  file_path TEXT NOT NULL, caller_key TEXT NOT NULL, callee_key TEXT NOT NULL,
  call_line INTEGER NOT NULL CHECK(call_line >= 1),
  is_sink INTEGER NOT NULL CHECK(is_sink IN (0,1)), rule_id TEXT,
  UNIQUE(uid, run_id, project_id),
  FOREIGN KEY(run_id, project_id) REFERENCES audit_runs(id, project_id)
) STRICT;
CREATE TABLE call_paths (
  path_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  path_hash TEXT NOT NULL, sink_edge_id TEXT,
  verdict TEXT NOT NULL CHECK(verdict IN ('unknown','safe','dangerous')),
  dangerous INTEGER CHECK(dangerous IN (0,1)),
  result_summary TEXT NOT NULL, created_at TEXT NOT NULL,
  CHECK((verdict = 'unknown' AND dangerous IS NULL) OR
        (verdict = 'safe' AND dangerous IS NOT NULL AND dangerous = 0) OR
        (verdict = 'dangerous' AND dangerous IS NOT NULL AND dangerous = 1)),
  UNIQUE(run_id, path_hash), UNIQUE(path_id, run_id, project_id),
  FOREIGN KEY(run_id, project_id) REFERENCES audit_runs(id, project_id),
  FOREIGN KEY(sink_edge_id, run_id, project_id) REFERENCES call_edges(uid, run_id, project_id)
) STRICT;
CREATE TABLE path_steps (
  path_id TEXT NOT NULL, step_index INTEGER NOT NULL CHECK(step_index >= 0),
  edge_uid TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  PRIMARY KEY(path_id, step_index),
  FOREIGN KEY(path_id, run_id, project_id) REFERENCES call_paths(path_id, run_id, project_id),
  FOREIGN KEY(edge_uid, run_id, project_id) REFERENCES call_edges(uid, run_id, project_id)
) STRICT;
CREATE TABLE reports (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, project_id TEXT NOT NULL,
  file_path TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  summary TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(run_id, project_id) REFERENCES audit_runs(id, project_id)
) STRICT;
CREATE INDEX idx_runs_project ON audit_runs(project_id, created_at);
CREATE INDEX idx_runs_model ON audit_runs(model_config_id);
CREATE INDEX idx_edges_run ON call_edges(run_id, project_id);
CREATE INDEX idx_paths_run ON call_paths(run_id, project_id);
CREATE INDEX idx_paths_sink ON call_paths(sink_edge_id, run_id, project_id);
CREATE INDEX idx_steps_edge ON path_steps(edge_uid, run_id, project_id);
CREATE INDEX idx_reports_run ON reports(run_id, project_id);
`
  },
  {
    version: 2,
    name: 'project-model-metadata',
    sql: `
ALTER TABLE projects ADD COLUMN git_url TEXT;
ALTER TABLE projects ADD COLUMN git_commit TEXT;
ALTER TABLE projects ADD COLUMN git_dirty INTEGER CHECK(git_dirty IN (0,1));
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);
ALTER TABLE model_configs ADD COLUMN api TEXT NOT NULL DEFAULT 'openai-completions'
  CHECK(api = 'openai-completions');
ALTER TABLE model_configs ADD COLUMN created_at TEXT NOT NULL DEFAULT '';
ALTER TABLE model_configs ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
UPDATE model_configs SET created_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
  updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE created_at='';
CREATE UNIQUE INDEX idx_models_secret_ref ON model_configs(secret_ref) WHERE secret_ref IS NOT NULL;
-- 旧 Git 记录缺少来源时保留原行，列表会标为待补全；新写入/更新必须完整。
CREATE TRIGGER validate_git_project_insert BEFORE INSERT ON projects
WHEN NEW.source_type='git' AND (NEW.git_url IS NULL OR NEW.git_url='' OR
 NEW.git_commit IS NULL OR length(NEW.git_commit) NOT IN (40,64) OR NEW.git_dirty IS NULL)
BEGIN SELECT RAISE(ABORT,'git metadata required'); END;
CREATE TRIGGER validate_git_project_update BEFORE UPDATE ON projects
WHEN NEW.source_type='git' AND (NEW.git_url IS NULL OR NEW.git_url='' OR
 NEW.git_commit IS NULL OR length(NEW.git_commit) NOT IN (40,64) OR NEW.git_dirty IS NULL)
BEGIN SELECT RAISE(ABORT,'git metadata required'); END;
-- 外部凭据库不能参与 SQLite 事务。此表只存待清理引用，绝不存 Key。
CREATE TABLE credential_cleanup (
  secret_ref TEXT PRIMARY KEY, created_at TEXT NOT NULL
) STRICT;
`
  },
  {
    version: 3,
    name: 'explicit-model-selection',
    sql: `
CREATE TABLE model_selection (
  slot INTEGER PRIMARY KEY CHECK(slot=1),
  config_id TEXT REFERENCES model_configs(id),
  revision INTEGER NOT NULL CHECK(revision>=0)
) STRICT;
-- 不替用户选第一条；新库与旧库升级都从“尚未选择”开始。
INSERT INTO model_selection VALUES (1,NULL,0);
`
  },
  {
    version: 4,
    name: 'source-import-registration',
    sql: `
CREATE TABLE source_imports (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  source_key TEXT NOT NULL, source_stamp TEXT NOT NULL,
  file_count INTEGER NOT NULL CHECK(file_count>0),
  total_bytes INTEGER NOT NULL CHECK(total_bytes>=0), registered_at TEXT NOT NULL
) STRICT;
CREATE INDEX idx_source_import_key ON source_imports(source_key,registered_at);
`
  },
  {
    version: 5,
    name: 'call-chain-graph-and-work-items',
    sql: callChainMigration
  },
  {
    version: 6,
    name: 'scan-progress-and-path-attempts',
    sql: scanMigration
  },
  {
    version: 7,
    name: 'analysis-events-run-lifecycle-and-reports',
    sql: analysisMigration
  },
  {
    version: 8,
    name: 'taint-review-and-session-scoped-stream-events',
    sql: streamMigration
  }
]

function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.sql).digest('hex')
}

export function migrate(db: LocalDatabase, plan: readonly Migration[] = migrations): void {
  // 历史迁移不可修改；未来加 version=2，而不是把已发布的 version=1 改掉。
  if (!plan.length || plan.some((item, index) => item.version !== index + 1))
    throw new ApiError('DB_MIGRATION_PLAN_INVALID', '数据库迁移版本必须从 1 连续递增')
  const version = Number(db.get('PRAGMA user_version')?.user_version)
  const appId = Number(db.get('PRAGMA application_id')?.application_id)
  const tables = db.all(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  if (
    (appId !== 0 && appId !== APPLICATION_ID) ||
    (appId === 0 && (tables.length > 0 || version !== 0))
  )
    throw new ApiError('DB_FOREIGN_DATABASE', '此文件不是本应用已识别的数据库，已停止初始化')
  if (version > plan.length)
    throw new ApiError('DB_SCHEMA_TOO_NEW', '数据库版本高于当前程序，请使用较新程序')
  if (appId === APPLICATION_ID && !tables.some((row) => row.name === 'schema_migrations'))
    throw new ApiError('DB_MIGRATION_MISMATCH', '数据库迁移记录缺失')
  if (tables.length > 0) {
    const records = db.all('SELECT version, name, checksum FROM schema_migrations ORDER BY version')
    if (
      records.length !== version ||
      records.some(
        (row, index) =>
          row.version !== index + 1 ||
          row.name !== plan[index]?.name ||
          row.checksum !== checksum(plan[index])
      )
    )
      throw new ApiError('DB_MIGRATION_MISMATCH', '数据库迁移记录与程序不一致')
  }
  // 建表、写账本、更新 user_version 为一个原子操作；失败时不会留下半套新表。
  db.transaction((tx) => {
    tx.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL, applied_at TEXT NOT NULL
    ) STRICT`)
    for (const migration of plan.slice(version)) {
      tx.exec(migration.sql)
      tx.run(
        'INSERT INTO schema_migrations VALUES (?, ?, ?, ?)',
        migration.version,
        migration.name,
        checksum(migration),
        new Date().toISOString()
      )
      // 版本来自程序内部受检整数；SQLite PRAGMA 赋值不支持 ? 占位符。
      tx.exec(`PRAGMA user_version = ${migration.version}`)
    }
    tx.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  })
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;')
  if (db.get('PRAGMA journal_mode')?.journal_mode !== 'wal')
    throw new ApiError('DB_WAL_UNAVAILABLE', '本地目录不能启用 WAL 日志模式')
  if (
    db.all('PRAGMA foreign_key_check').length ||
    db.get('PRAGMA quick_check')?.quick_check !== 'ok'
  )
    throw new ApiError('DB_INTEGRITY_FAILED', '数据库完整性检查未通过，请保留文件排查')
}

export function openStorage(dataRoot: string): LocalDatabase {
  const db = new LocalDatabase(dataRoot)
  try {
    migrate(db)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}
