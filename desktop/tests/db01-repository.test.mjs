import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { openStorage } from '../src/service/storage/schema.ts'
import { AuditRepository } from '../src/service/storage/repository.ts'
import { isStorageOverview } from '../src/shared/storage-contracts.ts'
import { completedFixture } from './db01-fixture.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-repo-'))
  const db = openStorage(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { db, repo: new AuditRepository(db) }
}
test('complete snapshot commits real rows, preserves order and overview contract', (t) => {
  const { db, repo } = fixture(t)
  repo.saveCompletedAudit(completedFixture())
  const result = repo.overview()
  assert.equal(isStorageOverview(result), true)
  assert.deepEqual(result.counts, { projects: 1, runs: 1, results: 1, reports: 1 })
  assert.equal(db.get('SELECT step_index FROM path_steps').step_index, 0)
  assert.equal(db.get('SELECT dangerous FROM call_paths').dangerous, 1)
  assert.equal(db.all('PRAGMA foreign_key_check').length, 0)
  assert.throws(() => db.run('UPDATE call_paths SET dangerous=NULL'), { code: 'DB_QUERY_FAILED' })
})
test('invalid final path step rolls back every earlier row including project', (t) => {
  const { repo } = fixture(t)
  const input = completedFixture()
  input.paths[0].edgeIds.push('missing-edge')
  assert.throws(() => repo.saveCompletedAudit(input), { code: 'DB_QUERY_FAILED' })
  assert.deepEqual(repo.overview().counts, { projects: 0, runs: 0, results: 0, reports: 0 })
})
test('composite foreign keys forbid cross-project/run references; unknown differs from safe', (t) => {
  const { db, repo } = fixture(t)
  repo.saveCompletedAudit(completedFixture('a'))
  const b = completedFixture('b')
  b.paths[0].sinkEdgeId = 'fixture-edge-a'
  assert.throws(() => repo.saveCompletedAudit(b), { code: 'DB_QUERY_FAILED' })
  b.paths[0].sinkEdgeId = 'fixture-edge-b'
  b.paths[0].verdict = 'unknown'
  repo.saveCompletedAudit(b)
  assert.equal(
    db.get("SELECT dangerous FROM call_paths WHERE path_id='fixture-path-b'").dangerous,
    null
  )
  assert.throws(() => db.run("UPDATE call_paths SET dangerous=1 WHERE path_id='fixture-path-b'"), {
    code: 'DB_QUERY_FAILED'
  })
})
test('oversize batch refused before write; recent lists are bounded to 20', (t) => {
  const { repo } = fixture(t)
  const huge = completedFixture()
  huge.paths[0].edgeIds = Array(1000).fill('x')
  assert.throws(() => repo.saveCompletedAudit(huge), { code: 'DB_BATCH_TOO_LARGE' })
  for (let n = 0; n < 21; n++) repo.saveCompletedAudit(completedFixture(String(n)))
  assert.equal(repo.overview().counts.projects, 21)
  assert.equal(repo.overview().projects.length, 20)
})
test('independent OS processes save and reopen identical project and analysis results', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-restart-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const worker = fileURLToPath(new URL('./db01-persistence-worker.mjs', import.meta.url))
  const run = (operation) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', worker, root, operation],
        { encoding: 'utf8' }
      )
    )
  const saved = run('seed'),
    reopened = run('read')
  assert.deepEqual(reopened, saved)
  assert.equal(reopened.results[0].id, 'fixture-path-one')
})
