import test from 'node:test'
import assert from 'node:assert/strict'
import { ModelTestController, isModelPingData, modelTestHint } from '../src/shared/model-test.ts'
const model = { configId: 'model-fixture', name: '教学配置', revision: 1 }
const ok = {
  ok: true,
  requestId: 'fixture-request',
  data: {
    reply: '你好，我已收到请求',
    latencyMs: 12,
    model: { configId: model.configId, modelId: 'fixture-model', revision: 1 }
  }
}
test('no call on creation/subscription; same-tick double click sends one fixed configuration ID', async () => {
  const c = new ModelTestController()
  let calls = 0,
    release
  const stop = c.subscribe(() => {})
  assert.equal(c.getSnapshot().status, 'idle')
  assert.equal(calls, 0)
  const pending = c.run(model, (id) => {
    calls++
    assert.equal(id, model.configId)
    return new Promise((r) => {
      release = r
    })
  })
  await c.run(model, async () => {
    calls++
    return ok
  })
  assert.equal(calls, 1)
  assert.equal(c.getSnapshot().status, 'running')
  release(ok)
  await pending
  assert.equal(c.getSnapshot().status, 'success')
  stop()
})
test('any nonempty reply counts, not only pong; failed/blank/invalid response never success', async () => {
  assert.equal(isModelPingData(ok.data), true)
  const c = new ModelTestController()
  await c.run(model, async () => ok)
  assert.equal(c.getSnapshot().data.reply, '你好，我已收到请求')
  for (const data of [
    { ...ok.data, reply: '  ' },
    { ...ok.data, latencyMs: -1 },
    { ...ok.data, apiKey: 'fixture-leak' }
  ]) {
    await c.run(model, async () => ({ ...ok, data }))
    assert.equal(c.getSnapshot().status, 'failure')
  }
})
test('error code and request ID preserved; unknown bridge exception does not echo raw text', async () => {
  const c = new ModelTestController()
  await c.run(model, async () => ({
    ok: false,
    requestId: 'fixture-failure',
    error: { code: 'MODEL_AUTH_FAILED', message: '鉴权失败', retryable: false }
  }))
  assert.equal(c.getSnapshot().requestId, 'fixture-failure')
  assert.ok(modelTestHint(c.getSnapshot().code).includes('API Key'))
  await c.run(model, async () => {
    throw new Error('fixture-secret-raw-error')
  })
  assert.equal(JSON.stringify(c.getSnapshot()).includes('fixture-secret-raw-error'), false)
})
test('result carries captured configuration and actual revision, rejects different ID', async () => {
  const c = new ModelTestController()
  await c.run(model, async () => ({
    ...ok,
    data: { ...ok.data, model: { ...ok.data.model, revision: 2 } }
  }))
  assert.equal(c.getSnapshot().expectedRevision, 1)
  assert.equal(c.getSnapshot().data.model.revision, 2)
  await c.run(model, async () => ({
    ...ok,
    data: { ...ok.data, model: { ...ok.data.model, configId: 'different-id' } }
  }))
  assert.equal(c.getSnapshot().code, 'MODEL_TEST_ID_MISMATCH')
})
