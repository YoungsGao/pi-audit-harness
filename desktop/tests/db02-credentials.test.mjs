import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage } from '../src/service/storage/schema.ts'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
import { MetadataService } from '../src/service/storage/metadata-service.ts'
import { WindowsCredentialStore } from '../src/service/storage/credential-store.ts'
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-db02-secret-')),
    db = openStorage(root),
    secrets = new Map()
  const vault = {
    write: async (r, k) => {
      secrets.set(r, k)
    },
    read: async (r) => secrets.get(r),
    delete: async (r) => {
      secrets.delete(r)
    }
  }
  const repo = new MetadataRepository(db),
    service = new MetadataService(repo, vault)
  t.after(async () => {
    await service.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { db, repo, service, vault, secrets }
}
const draft = {
  name: 'fixture model',
  baseUrl: 'https://example.invalid/v1',
  modelId: 'fixed-model'
}
test(
  'Windows Credential Manager real fake-key write/read/replace/delete; no third-party credentials accessed',
  { skip: process.platform !== 'win32' },
  async () => {
    const vault = new WindowsCredentialStore(),
      reference = 'PiAuditHarness/model/' + randomUUID()
    try {
      assert.equal(await vault.read(reference), undefined)
      await vault.write(reference, 'fixture-not-a-real-key-中文')
      assert.equal(
        await new WindowsCredentialStore().read(reference),
        'fixture-not-a-real-key-中文'
      )
      await vault.write(reference, 'fixture-replaced')
      assert.equal(await vault.read(reference), 'fixture-replaced')
      await vault.delete(reference)
      assert.equal(await vault.read(reference), undefined)
    } finally {
      await vault.delete(reference)
    }
  }
)
test('save and rotate key preserves config ID, increments revision, old key cleaned; no plaintext in DB/WAL/DTO', async (t) => {
  const { db, repo, service, secrets } = fixture(t),
    key = 'fixture-db02-' + randomUUID()
  const first = await service.saveModel({ ...draft, apiKey: key })
  const id = first.model.configId,
    oldRef = repo.getModel(id).secretRef
  assert.equal(await service.modelPorts().readSecret(oldRef), key)
  const second = await service.saveModel({
    ...draft,
    configId: id,
    expectedRevision: 1,
    apiKey: 'fixture-new'
  })
  assert.equal(second.model.configId, id)
  assert.equal(second.model.revision, 2)
  assert.equal(secrets.has(oldRef), false)
  assert.equal(secrets.size, 1)
  assert.equal(JSON.stringify(service.overview()).includes(key), false)
  for (const file of [db.filePath, db.filePath + '-wal', db.filePath + '-shm'])
    if (existsSync(file)) assert.equal(readFileSync(file).includes(Buffer.from(key)), false)
})
test('metadata-only edit keeps reference; missing key remains SQL NULL across multiple configs', async (t) => {
  const { db, repo, service } = fixture(t)
  const first = await service.saveModel(draft)
  assert.equal(first.model.credentialState, 'missing')
  await service.saveModel({ ...draft, configId: first.model.configId, expectedRevision: 1 })
  const other = await service.saveModel({ ...draft, name: 'second no-key config' })
  await service.saveModel({ ...draft, configId: other.model.configId, expectedRevision: 1 })
  assert.equal(db.get('SELECT count(*) AS n FROM model_configs WHERE secret_ref IS NULL').n, 2)
  const second = await service.saveModel({
    ...draft,
    configId: first.model.configId,
    expectedRevision: 2,
    apiKey: 'fixture-key'
  })
  const reference = repo.getModel(second.model.configId).secretRef
  await service.saveModel({
    ...draft,
    name: 'edit',
    configId: second.model.configId,
    expectedRevision: 3
  })
  assert.equal(repo.getModel(second.model.configId).secretRef, reference)
})
test('external write failure and stale revision never replace working config; orphan intention survives and recovers', async (t) => {
  const { repo, service, vault, secrets } = fixture(t)
  const first = await service.saveModel({ ...draft, apiKey: 'fixture-original' })
  const id = first.model.configId,
    oldRef = repo.getModel(id).secretRef
  await assert.rejects(
    service.saveModel({ ...draft, configId: id, expectedRevision: 8, apiKey: 'fixture-stale' }),
    { code: 'METADATA_REVISION_CONFLICT' }
  )
  const write = vault.write,
    remove = vault.delete
  vault.write = async (r, k) => {
    secrets.set(r, k)
    throw new Error('fixture external failure')
  }
  vault.delete = async () => {
    throw new Error('fixture temporarily unavailable')
  }
  await assert.rejects(
    service.saveModel({
      ...draft,
      configId: id,
      expectedRevision: 1,
      apiKey: 'fixture-uncommitted'
    })
  )
  assert.equal(repo.getModel(id).secretRef, oldRef)
  assert.equal(repo.cleanupCandidates().length, 1)
  vault.write = write
  vault.delete = remove
  await service.recover()
  assert.equal(repo.cleanupCandidates().length, 0)
  assert.equal(secrets.size, 1)
})
test('DB failure after vault write cleans new secret; shutdown cancels queued or precommit work', async (t) => {
  const { repo, service, secrets } = fixture(t)
  const commit = repo.commitModel.bind(repo)
  repo.commitModel = () => {
    throw new Error('fixture DB failure')
  }
  await assert.rejects(service.saveModel({ ...draft, apiKey: 'fixture-never-committed' }))
  assert.equal(secrets.size, 0)
  assert.equal(repo.cleanupCandidates().length, 0)
  repo.commitModel = commit
  const abort = new AbortController()
  abort.abort()
  assert.throws(() => service.saveModel(draft, abort.signal), { code: 'METADATA_CANCELLED' })
  await service.close()
  assert.throws(() => service.saveModel(draft), { code: 'METADATA_CANCELLED' })
})
