import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceService } from '../src/service/sources/service.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { sourceRequest } from '../src/main/source-client.ts'
import { createServer } from 'node:http'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
test('authenticated source HTTP and main DTO: actual local import/open/list; no arbitrary SQL, prompt or URL fields', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-http-')),
    db = openStorage(join(root, 'runtime')),
    service = new SourceService(db, join(root, 'runtime'))
  const server = await startHttpServer('fixture-source-token', {
    getSources: () => service.list(),
    getSourceTools: (s) => service.tools(s),
    sourceAction: (a, v, s) => service.action(a, v, s)
  })
  t.after(async () => {
    await server.close()
    await service.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const path = join(root, 'source')
  await mkdir(path)
  await writeFile(join(path, 'Demo.java'), 'class Demo{}')
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/sources`)).status, 401)
  const result = await sourceRequest(server.port, 'fixture-source-token', 'local', {
    projectName: 'http fixture',
    path
  })
  assert.equal(result.ok, true)
  assert.ok(result.requestId)
  assert.throws(
    () =>
      new MetadataRepository(db).saveProject(
        {
          projectId: result.data.projectId,
          expectedRevision: 1,
          projectName: 'cannot rewrite imported source',
          path,
          sourceType: 'local'
        },
        { path, commit: null, dirty: null }
      ),
    { code: 'SOURCE_PROJECT_LOCKED' }
  )
  const opened = await sourceRequest(server.port, 'fixture-source-token', 'open', {
    projectId: result.data.projectId
  })
  assert.equal(opened.ok, true)
  assert.equal(opened.data.changed, false)
  assert.equal((await sourceRequest(server.port, 'fixture-source-token', 'list')).data.total, 1)
  const bad = await sourceRequest(server.port, 'fixture-source-token', 'local', {
    projectName: 'x',
    path,
    prompt: 'injected'
  })
  assert.equal(bad.error.code, 'SOURCE_INPUT_INVALID')
  const sql = await fetch(`http://127.0.0.1:${server.port}/sources?sql=DROP`, {
    headers: { Authorization: 'Bearer fixture-source-token' }
  })
  assert.equal(sql.status, 404)
})
test('main process rejects extra sensitive fields in source response', async (t) => {
  const server = createServer((_q, r) =>
    r.end(
      JSON.stringify({
        ok: true,
        requestId: 'fixture-id',
        data: { projects: [], total: 0, apiKey: 'fixture-never-pass' }
      })
    )
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const result = await sourceRequest(server.address().port, 'fixture', 'list')
  assert.equal(result.ok, false)
  assert.equal(JSON.stringify(result).includes('fixture-never-pass'), false)
})
