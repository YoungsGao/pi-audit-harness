import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage } from '../src/service/storage/schema.ts'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
import { ModelSettingsRepository } from '../src/service/storage/model-settings-repository.ts'
import { MetadataService } from '../src/service/storage/metadata-service.ts'
import { resolveModelConfig } from '../src/service/model-config-resolver.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { modelSettingsRequest } from '../src/main/model-settings-client.ts'
import { createEnv02Fixture } from './env02-fixture.mjs'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { PiOperations } from '../src/service/pi-operations.ts'
const draft = {
  name: 'fixture config',
  baseUrl: 'https://example.invalid/v1',
  modelId: 'explicit-model'
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-mod01-service-')),
    db = openStorage(root),
    keys = new Map()
  const vault = {
    write: async (r, k) => {
      keys.set(r, k)
    },
    read: async (r) => keys.get(r),
    delete: async (r) => {
      keys.delete(r)
    }
  }
  const repo = new MetadataRepository(db),
    service = new MetadataService(repo, vault, new ModelSettingsRepository(db))
  t.after(async () => {
    await service.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, db, keys, vault, repo, service }
}
test('production snapshot queues key read with writes; in-flight snapshot retains old revision/key after rotation', async (t) => {
  const { vault, service } = setup(t),
    first = await service.saveModel({ ...draft, apiKey: 'fixture-old-key' })
  let release, started
  const gate = new Promise((r) => {
      release = r
    }),
    begin = new Promise((r) => {
      started = r
    }),
    read = vault.read
  vault.read = async (ref) => {
    started()
    await gate
    return read(ref)
  }
  const snapshot = resolveModelConfig(
    first.model.configId,
    service.modelPorts(),
    new AbortController().signal
  )
  await begin
  let saved = false
  const update = service
    .saveModel({
      ...draft,
      configId: first.model.configId,
      expectedRevision: 1,
      apiKey: 'fixture-new-key'
    })
    .then((x) => {
      saved = true
      return x
    })
  await Promise.resolve()
  assert.equal(saved, false)
  release()
  const old = await snapshot
  await update
  assert.equal(old.config.revision, 1)
  assert.equal(old.apiKey, 'fixture-old-key')
  assert.equal(Object.isFrozen(old.config), true)
  const current = await resolveModelConfig(
    first.model.configId,
    service.modelPorts(),
    new AbortController().signal
  )
  assert.equal(current.config.revision, 2)
  assert.equal(current.apiKey, 'fixture-new-key')
})
test('new endpoint requires new key; editing name/model preserves key, identity and selection', async (t) => {
  const { service } = setup(t),
    first = await service.saveModel({ ...draft, apiKey: 'fixture-key' })
  await service.selectModel({ configId: first.model.configId, expectedRevision: 0 })
  await assert.rejects(
    service.saveModel({
      ...draft,
      configId: first.model.configId,
      expectedRevision: 1,
      baseUrl: 'https://other.example.invalid/v1'
    }),
    { code: 'MODEL_KEY_REENTRY_REQUIRED' }
  )
  await service.saveModel({
    ...draft,
    name: 'changed',
    modelId: 'chosen-other-model',
    configId: first.model.configId,
    expectedRevision: 1
  })
  assert.equal(service.catalog().selection.configId, first.model.configId)
  assert.equal(service.catalog().selection.model.modelId, 'chosen-other-model')
})
test('HTTP selection is authenticated and validated; stale/missing errors retain request ID; no query API', async (t) => {
  const { service } = setup(t),
    saved = await service.saveModel(draft)
  const server = await startHttpServer('fixture-token', {
    getModelCatalog: () => service.catalog(),
    selectModel: (v, s) => service.selectModel(v, s)
  })
  t.after(() => server.close())
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/models`)).status, 401)
  const selected = await modelSettingsRequest(server.port, 'fixture-token', {
    configId: saved.model.configId,
    expectedRevision: 0
  })
  assert.equal(selected.ok, true)
  assert.equal(selected.data.selection.configId, saved.model.configId)
  const stale = await modelSettingsRequest(server.port, 'fixture-token', {
    configId: null,
    expectedRevision: 0
  })
  assert.equal(stale.error.code, 'MODEL_SELECTION_CONFLICT')
  assert.ok(stale.requestId)
  assert.equal(
    (await modelSettingsRequest(server.port, 'fixture-token')).data.selection.configId,
    saved.model.configId
  )
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${server.port}/models?sql=DROP`, {
        headers: { Authorization: 'Bearer fixture-token' }
      })
    ).status,
    404
  )
})
test('selected saved model reaches exact local endpoint/model through actual Pi SDK; saving and selection send no request', async (t) => {
  const { root, service } = setup(t),
    a = await createEnv02Fixture(),
    b = await createEnv02Fixture(),
    runtime = new PiRuntime(join(root, 'pi'))
  t.after(async () => {
    await runtime.close()
    await a.close()
    await b.close()
  })
  const first = await service.saveModel({
    ...draft,
    baseUrl: a.config.baseUrl,
    modelId: 'fixture-a',
    apiKey: 'fixture-a-key'
  })
  const second = await service.saveModel({
    ...draft,
    baseUrl: b.config.baseUrl,
    modelId: 'fixture-b',
    apiKey: 'fixture-b-key'
  })
  await service.selectModel({ configId: second.model.configId, expectedRevision: 0 })
  assert.equal(a.requests.length + b.requests.length, 0)
  await runtime.initialize()
  const result = await new PiOperations(runtime, service.modelPorts()).ping(
    service.catalog().selection.configId,
    { requestId: 'fixture-selected' }
  )
  assert.equal(result.model.configId, second.model.configId)
  assert.equal(result.model.modelId, 'fixture-b')
  assert.equal(a.requests.length, 0)
  assert.equal(b.requests.length, 1)
  assert.equal(b.requests[0].model, 'fixture-b')
  assert.notEqual(first.model.configId, second.model.configId)
})
test('missing credential never falls back to another model, discovered model or environment key', async (t) => {
  const { service, keys } = setup(t),
    first = await service.saveModel({ ...draft, apiKey: 'fixture-removed' })
  await service.selectModel({ configId: first.model.configId, expectedRevision: 0 })
  keys.clear()
  await assert.rejects(
    resolveModelConfig(first.model.configId, service.modelPorts(), new AbortController().signal),
    { code: 'MODEL_CREDENTIAL_MISSING' }
  )
  assert.equal(service.catalog().selection.configId, first.model.configId)
})
