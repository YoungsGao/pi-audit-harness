import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

test('统一响应保留同一次请求的标识，未知错误不泄露内部内容', async () => {
  const url = new URL('../src/service/response.ts', import.meta.url)
  assert.ok(existsSync(url), '统一响应模块尚未实现')
  const { createRequestContext, successResult, failureResult } = await import(url.href)
  const { ApiError } = await import('../src/shared/api-error.ts')
  const context = createRequestContext({ projectId: 'project-test', runId: 'run-test' })
  const ok = successResult(context, { reply: '测试结果' })
  assert.equal(ok.requestId, context.requestId)
  assert.equal(ok.projectId, 'project-test')
  const bad = failureResult(context, new ApiError('MODEL_TIMEOUT', '模型调用超时', 504, true))
  assert.equal(bad.status, 504)
  assert.equal(bad.body.runId, 'run-test')
  assert.equal(bad.body.requestId, ok.requestId)
  assert.equal(bad.body.error.code, 'MODEL_TIMEOUT')
  const unknown = failureResult(context, new Error('secret-should-not-leak'))
  assert.equal(unknown.body.error.code, 'INTERNAL_ERROR')
  assert.equal(JSON.stringify(unknown).includes('secret-should-not-leak'), false)
  assert.throws(() => createRequestContext({ projectId: 12 }), /projectId/)
  assert.throws(() => createRequestContext({ runId: 'run-without-project' }), /projectId/)
})

test('主进程解析真实 HTTP 错误时保留后端错误码与请求编号', async () => {
  const { startHttpServer } = await import('../src/service/http-server.ts')
  const { checkLocalHealth } = await import('../src/main/service-client.ts')
  const running = await startHttpServer('correct-token')
  try {
    await assert.rejects(checkLocalHealth(running.port, 'wrong-token'), (error) => {
      assert.equal(error.code, 'UNAUTHORIZED')
      assert.equal(typeof error.requestId, 'string')
      return true
    })
  } finally {
    await running.close()
  }
})
