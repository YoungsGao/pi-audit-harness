import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDatabase } from '../src/service/storage/database.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-'))
  const db = new LocalDatabase(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return db
}

test('absolute data directory, real file, foreign keys and bound parameters', (t) => {
  assert.throws(() => new LocalDatabase('relative'), { code: 'DB_INVALID_ROOT' })
  const db = fixture(t)
  assert.ok(existsSync(db.filePath))
  assert.equal(db.get('PRAGMA foreign_keys').foreign_keys, 1)
  db.exec('CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL) STRICT')
  const text = "a'); DROP TABLE notes; --中文"
  db.run('INSERT INTO notes VALUES (?, ?)', 'n1', text)
  assert.equal(db.get('SELECT title FROM notes WHERE id = ?', 'n1').title, text)
})

test('batch commit and failed batch rollback; connection remains usable', (t) => {
  const db = fixture(t)
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY) STRICT')
  db.transaction((tx) => {
    tx.run('INSERT INTO notes VALUES (?)', 1)
    tx.run('INSERT INTO notes VALUES (?)', 2)
  })
  assert.throws(
    () =>
      db.transaction((tx) => {
        tx.run('INSERT INTO notes VALUES (?)', 3)
        tx.run('INSERT INTO notes VALUES (?)', 1)
      }),
    { code: 'DB_QUERY_FAILED' }
  )
  assert.equal(db.get('SELECT count(*) AS n FROM notes').n, 2)
  db.run('INSERT INTO notes VALUES (?)', 4)
})

test('nested/async transactions rejected; ended scoped session cannot write', (t) => {
  const db = fixture(t)
  assert.throws(() => db.transaction(() => db.transaction(() => 1)), {
    code: 'DB_NESTED_TRANSACTION'
  })
  assert.throws(() => db.transaction(async () => 1), { code: 'DB_ASYNC_TRANSACTION' })
  assert.throws(() => db.transaction(() => Promise.resolve(1)), { code: 'DB_ASYNC_TRANSACTION' })
  let scoped
  db.transaction((tx) => {
    scoped = tx
  })
  assert.throws(() => scoped.get('SELECT 1'), { code: 'DB_TRANSACTION_ENDED' })
})

test('open failure is safe and closing is idempotent', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-bad-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'storage', 'audit.sqlite3'), { recursive: true })
  assert.throws(() => new LocalDatabase(root), { code: 'DB_OPEN_FAILED' })
  const db = fixture(t)
  db.close()
  db.close()
  assert.throws(() => db.get('SELECT 1'), { code: 'DB_CLOSED' })
})
