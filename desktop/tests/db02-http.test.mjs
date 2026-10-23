import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage } from '../src/service/storage/schema.ts'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
import { MetadataService } from '../src/service/storage/metadata-service.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { metadataRequest } from '../src/main/metadata-client.ts'
test('authenticated metadata write/read uses fixed routes and strips credentials; stale update rejected', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-db02-http-')),
    db = openStorage(root),
    map = new Map()
  const meta = new MetadataService(new MetadataRepository(db), {
    write: async (r, k) => {
      map.set(r, k)
    },
    read: async (r) => map.get(r),
    delete: async (r) => {
      map.delete(r)
    }
  })
  const server = await startHttpServer('fixture-token', {
    getMetadata: () => meta.overview(),
    saveProject: (v, s) => meta.saveProject(v, s),
    saveModel: (v, s) => meta.saveModel(v, s)
  })
  t.after(async () => {
    await server.close()
    await meta.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const url = `http://127.0.0.1:${server.port}`
  assert.equal((await fetch(url + '/metadata')).status, 401)
  const p = await metadataRequest(server.port, 'fixture-token', 'project', {
    projectName: 'HTTP项目',
    path: root,
    sourceType: 'local'
  })
  assert.equal(p.ok, true)
  assert.equal(p.data.gitUrl, null)
  const m = await metadataRequest(server.port, 'fixture-token', 'model', {
    name: 'HTTP模型',
    baseUrl: 'https://example.invalid/v1',
    modelId: 'chosen',
    apiKey: 'fixture-http-key'
  })
  assert.equal(m.ok, true)
  assert.equal(m.data.model.credentialState, 'referenced')
  const list = await metadataRequest(server.port, 'fixture-token', 'list')
  assert.equal(list.data.projects[0].projectId, p.data.projectId)
  assert.equal(JSON.stringify(list).includes('fixture-http-key'), false)
  assert.equal(JSON.stringify(list).includes('secretRef'), false)
  const bad = await metadataRequest(server.port, 'fixture-token', 'model', {
    name: 'm',
    baseUrl: 'https://example.invalid',
    modelId: 'x',
    secretRef: 'foreign'
  })
  assert.equal(bad.error.code, 'INVALID_METADATA')
  const stale = await metadataRequest(server.port, 'fixture-token', 'project', {
    projectId: p.data.projectId,
    expectedRevision: 9,
    projectName: 'bad',
    path: root,
    sourceType: 'local'
  })
  assert.equal(stale.error.code, 'METADATA_REVISION_CONFLICT')
  assert.equal(
    (
      await fetch(url + '/metadata?sql=DROP', {
        headers: { Authorization: 'Bearer fixture-token' }
      })
    ).status,
    404
  )
})
