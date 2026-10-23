import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage, migrations, migrate } from '../src/service/storage/schema.ts'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
import {
  ModelSettingsRepository,
  parseSelection
} from '../src/service/storage/model-settings-repository.ts'
import { isModelCatalog } from '../src/shared/model-settings.ts'
const draft = {
  name: 'fixture config',
  baseUrl: 'https://example.invalid/v1',
  modelId: 'explicit-model'
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-mod01-')),
    db = openStorage(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, db, meta: new MetadataRepository(db), settings: new ModelSettingsRepository(db) }
}
test('selection starts empty; save never selects first model; explicit choose and clear persist independently', (t) => {
  const { meta, settings } = setup(t)
  assert.equal(settings.catalog().selection.configId, null)
  meta.commitModel(draft, 'config-a', null)
  meta.commitModel(draft, 'config-b', null)
  assert.equal(settings.catalog().selection.configId, null)
  assert.equal(
    settings.select({ configId: 'config-b', expectedRevision: 0 }).selection.configId,
    'config-b'
  )
  meta.commitModel(
    { ...draft, configId: 'config-a', expectedRevision: 1, name: 'edited a' },
    'config-a',
    null
  )
  assert.equal(settings.catalog().selection.configId, 'config-b')
  assert.equal(settings.select({ configId: null, expectedRevision: 1 }).selection.configId, null)
  assert.ok(isModelCatalog(settings.catalog()))
})
test('stale or missing selection rejected without changing current state; no silent fallback', (t) => {
  const { meta, settings } = setup(t)
  meta.commitModel(draft, 'config-a', null)
  settings.select({ configId: 'config-a', expectedRevision: 0 })
  assert.throws(() => settings.select({ configId: null, expectedRevision: 0 }), {
    code: 'MODEL_SELECTION_CONFLICT'
  })
  assert.throws(() => settings.select({ configId: 'missing', expectedRevision: 1 }), {
    code: 'MODEL_CONFIG_NOT_FOUND'
  })
  assert.equal(settings.catalog().selection.configId, 'config-a')
  for (const value of [
    { configId: 'a' },
    { configId: 'a', expectedRevision: 0, apiKey: 'fixture' },
    { configId: '', expectedRevision: 0 }
  ])
    assert.throws(() => parseSelection(value), { code: 'INVALID_MODEL_SELECTION' })
})
test('selection survives v2 migration and process connection reopen; old metadata and checksum retained', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-mod01-upgrade-')),
    db = new LocalDatabase(root)
  let reopened
  t.after(() => {
    db.close()
    reopened?.close()
    rmSync(root, { recursive: true, force: true })
  })
  migrate(db, migrations.slice(0, 2))
  new MetadataRepository(db).commitModel(draft, 'legacy-config', null)
  const hash = db.get('SELECT checksum FROM schema_migrations WHERE version=2').checksum
  migrate(db)
  const settings = new ModelSettingsRepository(db)
  assert.equal(settings.catalog().selection.configId, null)
  settings.select({ configId: 'legacy-config', expectedRevision: 0 })
  db.close()
  reopened = openStorage(root)
  assert.equal(new ModelSettingsRepository(reopened).catalog().selection.configId, 'legacy-config')
  assert.equal(
    reopened.get('SELECT checksum FROM schema_migrations WHERE version=2').checksum,
    hash
  )
})
test('selected summary remains available outside 100-row list; strict DTO rejects credential leaks', (t) => {
  const { db, meta, settings } = setup(t)
  for (let i = 0; i < 101; i++)
    meta.commitModel(draft, 'config-' + String(i).padStart(3, '0'), null)
  db.run('UPDATE model_configs SET updated_at=? WHERE id=?', '2000-01-01', 'config-100')
  const state = settings.select({ configId: 'config-100', expectedRevision: 0 })
  assert.equal(state.models.length, 100)
  assert.equal(
    state.models.some((model) => model.configId === 'config-100'),
    false
  )
  assert.equal(state.selection.model.configId, 'config-100')
  assert.equal(
    isModelCatalog({ ...state, models: [{ ...state.models[0], apiKey: 'fixture' }] }),
    false
  )
})
