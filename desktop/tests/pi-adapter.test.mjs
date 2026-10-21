import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'
import { createPiFixture } from './pi-fixture.mjs'

test('Pi 适配器经真实 SDK 调用本地测试服务，并保留业务标识', async () => {
  const moduleUrl = new URL('../src/service/pi-adapter.ts', import.meta.url)
  assert.ok(existsSync(moduleUrl), 'Pi 适配器尚未实现')
  const { runPiPrompt } = await import(moduleUrl.href)
  const fixture = await createPiFixture()
  try {
    const result = await runPiPrompt(fixture.options, {
      prompt: '测试',
      context: { requestId: 'request-test', projectId: 'project-test', runId: 'run-test' }
    })
    assert.equal(result.reply, '本地测试回复')
    assert.equal(result.requestId, 'request-test')
    assert.equal(result.projectId, 'project-test')
    assert.equal(result.runId, 'run-test')
    assert.equal(fixture.requestCount, 1)
    assert.ok(result.latencyMs >= 0)
  } finally {
    await fixture.close()
  }
})

test('超时取消实际 SDK 操作，取消前置请求不发出模型请求', async () => {
  const moduleUrl = new URL('../src/service/pi-adapter.ts', import.meta.url)
  assert.ok(existsSync(moduleUrl), 'Pi 适配器尚未实现')
  const { runPiPrompt } = await import(moduleUrl.href)
  const fixture = await createPiFixture({ holdReply: true })
  try {
    await assert.rejects(
      runPiPrompt(fixture.options, {
        prompt: '测试超时',
        timeoutMs: 300,
        context: { requestId: 'timeout-test' }
      }),
      (error) => error.code === 'MODEL_TIMEOUT'
    )
    const before = fixture.requestCount
    await assert.rejects(
      runPiPrompt(fixture.options, {
        prompt: '已取消',
        signal: AbortSignal.abort(),
        context: { requestId: 'cancel-test' }
      }),
      (error) => error.code === 'CANCELLED'
    )
    assert.equal(fixture.requestCount, before)
  } finally {
    await fixture.close()
  }
})
