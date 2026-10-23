import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { postModelTest } from '../src/main/service-client.ts'
async function endpoint(t, data) {
  const server = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ ok: true, requestId: 'fixture-id', data }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return server.address().port
}
const data = {
  reply: '不是 pong 也成功',
  latencyMs: 10,
  model: { configId: 'fixture-config', revision: 1, modelId: 'fixture-model' }
}
test('main client rejects a different ID, empty body or invalid timing even after HTTP 200', async (t) => {
  for (const bad of [
    { ...data, model: { ...data.model, configId: 'other' } },
    { ...data, reply: ' ' },
    { ...data, latencyMs: -5 }
  ]) {
    const result = await postModelTest(await endpoint(t, bad), 'fixture-token', 'fixture-config')
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'INVALID_TEST_RESPONSE')
  }
})
test('main client preserves non-pong reply and latency without arbitrary extra response fields', async (t) => {
  const result = await postModelTest(await endpoint(t, data), 'fixture-token', 'fixture-config')
  assert.equal(result.ok, true)
  assert.equal(result.data.reply, data.reply)
  assert.equal(result.data.latencyMs, 10)
  for (const bad of [
    { ...data, apiKey: 'fixture-private-value' },
    { ...data, model: { ...data.model, secretRef: 'private-reference' } }
  ]) {
    const response = await postModelTest(await endpoint(t, bad), 'fixture-token', 'fixture-config')
    assert.equal(response.ok, false)
    assert.equal(JSON.stringify(response).includes('private'), false)
  }
})
