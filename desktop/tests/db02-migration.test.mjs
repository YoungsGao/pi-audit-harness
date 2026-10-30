import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { migrate, migrations } from '../src/service/storage/schema.ts'

test('real v1 data and references survive v2 migration; no invented legacy Git commit', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-db02-migration-')),
    db = new LocalDatabase(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  migrate(db, [migrations[0]])
  db.run(
    'INSERT INTO model_configs VALUES (?,?,?,?,?,?)',
    'legacy-model',
    '旧配置',
    'https://example.invalid/v1',
    'explicit-model',
    null,
    1
  )
  db.run(
    'INSERT INTO projects VALUES (?,?,?,?,?,?)',
    'legacy',
    '旧 Git 项目',
    'C:/old',
    'git',
    'before',
    'before'
  )
  db.run(
    "INSERT INTO audit_runs VALUES ('run-old','legacy','completed','old-source','v1',NULL,'before','before')"
  )
  const oldChecksum = db.get('SELECT checksum FROM schema_migrations WHERE version=1').checksum
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 12)
  const preserved = db.get("SELECT * FROM model_configs WHERE id='legacy-model'")
  assert.equal(preserved.model_id, 'explicit-model')
  assert.equal(preserved.secret_ref, null)
  assert.ok(preserved.created_at)
  assert.equal(
    db.get('SELECT checksum FROM schema_migrations WHERE version=1').checksum,
    oldChecksum
  )
  assert.equal(db.get("SELECT git_commit FROM projects WHERE id='legacy'").git_commit, null)
  assert.equal(db.get('SELECT project_id FROM audit_runs').project_id, 'legacy')
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
  assert.throws(
    () =>
      db.run(
        'INSERT INTO projects (id,name,path,source_type,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        'new',
        'new',
        'C:/new',
        'git',
        'now',
        'now'
      ),
    { code: 'DB_QUERY_FAILED' }
  )
  assert.equal(
    db.all('PRAGMA table_info(model_configs)').some((r) => /api_key|password|token/.test(r.name)),
    false
  )
})
