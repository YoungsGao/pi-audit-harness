import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import test from 'node:test'

test('本地服务支持认证、真实健康响应、404 和关闭', async () => {
  const moduleUrl = new URL('../src/service/http-server.ts', import.meta.url)
  assert.ok(existsSync(moduleUrl), '受控 HTTP 服务模块尚未实现')
  const { startHttpServer } = await import(moduleUrl.href)
  const running = await startHttpServer('test-token')
  const baseUrl = `http://127.0.0.1:${running.port}`
  const headers = { Authorization: 'Bearer test-token' }

  try {
    assert.ok(running.port > 0)
    const unauthorized = await fetch(`${baseUrl}/health`)
    assert.equal(unauthorized.status, 401)
    assert.equal((await unauthorized.json()).error.code, 'UNAUTHORIZED')
    const wrongToken = await fetch(`${baseUrl}/health`, {
      headers: { Authorization: 'Bearer incorrect' }
    })
    assert.equal(wrongToken.status, 401)
    const healthResponse = await fetch(`${baseUrl}/health`, { headers })
    const health = await healthResponse.json()
    assert.equal(healthResponse.status, 200)
    assert.equal(health.ok, true)
    assert.equal(typeof health.requestId, 'string')
    assert.equal('runId' in health, false)
    assert.deepEqual(health.data, {
      service: 'pi-audit-local',
      stage: 'http-ready',
      pi: 'not-integrated'
    })
    const missing = await fetch(`${baseUrl}/missing`, { headers })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'NOT_FOUND')
    assert.notEqual((await wrongToken.json()).requestId, health.requestId)
  } finally {
    await running.close()
  }
  await running.close()
  await assert.rejects(fetch(`${baseUrl}/health`, { headers }))
})
