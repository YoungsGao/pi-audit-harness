import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { startHttpServer } from '../src/service/http-server.ts'
import { readStorageOverview } from '../src/main/storage-client.ts'
import { checkLocalHealth } from '../src/main/service-client.ts'
import { openStorage } from '../src/service/storage/schema.ts'
import { AuditRepository } from '../src/service/storage/repository.ts'
import { completedFixture } from './db01-fixture.mjs'

test('authenticated fixed read route returns saved rows; no SQL/write route; health separates DB/Pi', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-db01-http-'))
  const db = openStorage(root),
    repo = new AuditRepository(db)
  repo.saveCompletedAudit(completedFixture())
  const server = await startHttpServer('fixture-secret', {
    getDatabase: () => repo.getInfo(),
    getStorageOverview: () => repo.overview()
  })
  t.after(async () => {
    await server.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.port}`
  assert.equal((await fetch(url + '/storage/overview')).status, 401)
  const result = await readStorageOverview(server.port, 'fixture-secret')
  assert.equal(result.ok, true)
  assert.equal(result.data.results[0].id, 'fixture-path-one')
  assert.ok(result.requestId)
  const health = await checkLocalHealth(server.port, 'fixture-secret')
  assert.equal(health.database.schemaVersion, 12)
  assert.equal(health.pi, 'not-integrated')
  for (const [method, path] of [
    ['POST', '/storage/overview'],
    ['GET', '/storage/overview?sql=DROP'],
    ['GET', '/db']
  ])
    assert.equal(
      (await fetch(url + path, { method, headers: { Authorization: 'Bearer fixture-secret' } }))
        .status,
      404
    )
})
test('storage client preserves service errors and rejects malformed success payloads', async (t) => {
  const absent = await startHttpServer('fixture-secret')
  t.after(() => absent.close())
  const failure = await readStorageOverview(absent.port, 'fixture-secret')
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, 'DB_NOT_READY')
  const malformed = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, requestId: 'fixture-id', data: { counts: {} } }))
  })
  await new Promise((resolve) => malformed.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => malformed.close(resolve)))
  assert.equal(
    (await readStorageOverview(malformed.address().port, 'x')).error.code,
    'INVALID_STORAGE_RESPONSE'
  )
})
