import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { modelSettingsRequest } from '../src/main/model-settings-client.ts'
import { openStorage } from '../src/service/storage/schema.ts'
import { MetadataRepository } from '../src/service/storage/metadata-repository.ts'
import { MetadataService } from '../src/service/storage/metadata-service.ts'
import { startHttpServer } from '../src/service/http-server.ts'
test('main process rejects response payload with extra key or credential reference', async (t) => {
  const data = {
    models: [
      {
        configId: 'fixture',
        name: 'n',
        baseUrl: 'https://example.invalid',
        modelId: 'm',
        revision: 1,
        credentialState: 'missing',
        apiKey: 'fixture-never-return'
      }
    ],
    total: 1,
    selection: { configId: null, revision: 0, model: null }
  }
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, requestId: 'fixture-response', data }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const result = await modelSettingsRequest(server.address().port, 'fixture-token')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'INVALID_MODEL_SETTINGS_RESPONSE')
  assert.equal(JSON.stringify(result).includes('fixture-never-return'), false)
})
test('unknown credential exception and submitted key never echo in ordinary API error response', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-mod01-error-')),
    db = openStorage(root)
  const service = new MetadataService(new MetadataRepository(db), {
    write: async () => {
      throw new Error('fixture-sensitive-internal-value')
    },
    read: async () => undefined,
    delete: async () => {}
  })
  const server = await startHttpServer('fixture-token', {
    saveModel: (v, s) => service.saveModel(v, s)
  })
  t.after(async () => {
    await server.close()
    await service.close()
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  const response = await fetch(`http://127.0.0.1:${server.port}/metadata/models`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'fixture',
      baseUrl: 'https://example.invalid',
      modelId: 'chosen',
      apiKey: 'fixture-submitted-private-value'
    })
  })
  const text = await response.text(),
    body = JSON.parse(text)
  assert.equal(body.ok, false)
  assert.equal(body.error.code, 'INTERNAL_ERROR')
  assert.ok(body.requestId)
  assert.equal(text.includes('fixture-sensitive-internal-value'), false)
  assert.equal(text.includes('fixture-submitted-private-value'), false)
})
