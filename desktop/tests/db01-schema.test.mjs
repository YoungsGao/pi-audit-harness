import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage, migrate, migrations } from '../src/service/storage/schema.ts'
import { LocalDatabase } from '../src/service/storage/database.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-schema-'))
  const db = openStorage(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return db
}
test('first boot creates domain tables, migration/cleanup ledgers, indexes and version; repeat is safe', (t) => {
  const db = fixture(t)
  assert.equal(db.all("SELECT name FROM sqlite_schema WHERE type='table'").length, 31)
  assert.equal(db.get('PRAGMA user_version').user_version, 12)
  assert.equal(db.get('PRAGMA journal_mode').journal_mode, 'wal')
  assert.equal(db.get('PRAGMA synchronous').synchronous, 2)
  assert.equal(
    db.all("SELECT name FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_%'").length,
    16
  )
  migrate(db)
  assert.equal(db.get('SELECT count(*) AS n FROM schema_migrations').n, 12)
})
test('failed migration rolls back DDL and version together', (t) => {
  const db = fixture(t)
  assert.throws(() =>
    migrate(db, [
      ...migrations,
      {
        version: 13,
        name: 'broken',
        sql: 'CREATE TABLE temporary_new (id INTEGER); INSERT INTO table_does_not_exist VALUES (1);'
      }
    ])
  )
  assert.equal(db.get('PRAGMA user_version').user_version, 12)
  assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='temporary_new'"), undefined)
  assert.equal(db.get('SELECT count(*) AS n FROM schema_migrations').n, 12)
})
test('newer version and modified history are rejected without resetting data', (t) => {
  const db = fixture(t)
  assert.throws(
    () =>
      migrate(db, [
        { ...migrations[0], sql: migrations[0].sql + '-- changed' },
        ...migrations.slice(1)
      ]),
    {
      code: 'DB_MIGRATION_MISMATCH'
    }
  )
  db.exec('PRAGMA user_version = 13')
  assert.throws(() => migrate(db), { code: 'DB_SCHEMA_TOO_NEW' })
  assert.equal(db.get('PRAGMA user_version').user_version, 13)
})
test('unrecognized database and invalid migration plan rejected', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-foreign-'))
  const db = new LocalDatabase(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.exec('CREATE TABLE personal_notes (text TEXT)')
  assert.throws(() => migrate(db), { code: 'DB_FOREIGN_DATABASE' })
  assert.throws(() => migrate(db, [{ version: 2, name: 'gap', sql: 'SELECT 1' }]), {
    code: 'DB_MIGRATION_PLAN_INVALID'
  })
  assert.ok(db.get("SELECT name FROM sqlite_schema WHERE name='personal_notes'"))
})
