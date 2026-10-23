import assert from 'node:assert/strict'
import test from 'node:test'
import { startHttpServer } from '../src/service/http-server.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { PiOperations } from '../src/service/pi-operations.ts'
import { checkLocalHealth, postModelTest } from '../src/main/service-client.ts'
import { createEnv02Fixture } from './env02-fixture.mjs'

test('HTTP 健康与 test 经实际 SDK，主进程保留错误编号，额外提示词被拒绝', async () => {
  const fixture = await createEnv02Fixture()
  const runtime = new PiRuntime(fixture.directory)
  const operations = new PiOperations(runtime, fixture.ports)
  await runtime.initialize()
  const running = await startHttpServer('owned-test-token', {
    getRuntime: () => runtime.getStatus(),
    testModel: (id, context, signal) => operations.ping(id, context, 15000, signal)
  })
  try {
    const health = await checkLocalHealth(running.port, 'owned-test-token')
    assert.equal(health.runtime.state, 'ready')
    assert.equal(fixture.requests.length, 0)
    const ok = await postModelTest(running.port, 'owned-test-token', fixture.config.id)
    assert.equal(ok.ok, true)
    assert.equal(ok.data.reply, '本机测试回复')
    assert.equal(fixture.requests.length, 1)
    const missing = await postModelTest(running.port, 'owned-test-token', 'missing')
    assert.equal(missing.ok, false)
    assert.equal(missing.error.code, 'MODEL_CONFIG_NOT_FOUND')
    assert.equal(typeof missing.requestId, 'string')
    const invalid = await fetch('http://127.0.0.1:' + running.port + '/test', {
      method: 'POST',
      headers: { Authorization: 'Bearer owned-test-token' },
      body: JSON.stringify({ modelConfigId: fixture.config.id, prompt: '不允许前端传任意提示词' })
    })
    assert.equal(invalid.status, 400)
    assert.equal(fixture.requests.length, 1)
  } finally {
    await running.close()
    await runtime.close()
    await fixture.close()
  }
})
