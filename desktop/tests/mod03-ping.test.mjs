import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { PiOperations } from '../src/service/pi-operations.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { postModelTest } from '../src/main/service-client.ts'
import { createMod03Fixture } from './mod03-fixture.mjs'
async function setup(t, mode = 'success', delayMs = 0) {
  const root = mkdtempSync(join(tmpdir(), 'pi-mod03-')),
    fixture = await createMod03Fixture({ mode, delayMs }),
    runtime = new PiRuntime(root)
  const ports = {
    getConfig: async (id) => (id === fixture.config.id ? fixture.config : undefined),
    readSecret: async () => 'fixture-mod03-key'
  }
  const operations = new PiOperations(runtime, ports)
  t.after(async () => {
    await runtime.close()
    await fixture.close()
    rmSync(root, { recursive: true, force: true })
  })
  return { root, fixture, runtime, operations }
}
test('fresh actual SDK session sends one ping and no tools/source/history/discovery; non-pong reply succeeds', async (t) => {
  const { root, fixture, runtime, operations } = await setup(t)
  mkdirSync(join(root, 'project'))
  writeFileSync(join(root, 'project', 'Secret.java'), 'MOD03_SOURCE_SENTINEL_NEVER_SEND')
  await runtime.initialize()
  assert.equal(fixture.requests.length, 0)
  const result = await operations.ping(fixture.config.id, { requestId: 'fixture-ping' })
  assert.ok(result.reply.includes('本机模型'))
  assert.notEqual(result.reply, 'pong')
  assert.ok(result.latencyMs >= 0)
  assert.equal(fixture.requests.length, 1)
  const req = fixture.requests[0]
  assert.equal(req.path, '/v1/chat/completions')
  assert.equal(req.body.model, 'explicit-fixture-model')
  const users = req.body.messages.filter((x) => x.role === 'user')
  assert.deepEqual(users, [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }])
  assert.equal(req.body.tools?.length ?? 0, 0)
  assert.equal(JSON.stringify(req.body).includes('MOD03_SOURCE_SENTINEL_NEVER_SEND'), false)
  assert.equal(
    req.body.messages.some((x) => x.role === 'tool' || x.role === 'assistant'),
    false
  )
})
test('actual SDK empty reply and oversized reply never count as success', async (t) => {
  for (const [mode, code] of [
    ['empty', 'EMPTY_REPLY'],
    ['large', 'MODEL_RESPONSE_TOO_LARGE']
  ]) {
    const s = await setup(t, mode)
    await assert.rejects(s.operations.ping(s.fixture.config.id, { requestId: 'fixture-' + mode }), {
      code
    })
    assert.equal(s.fixture.requests.length, 1)
  }
})
test('actual SDK auth/forbidden/model/quota/server failures have safe categories and no automatic retry', async (t) => {
  for (const [mode, code] of [
    ['auth', 'MODEL_AUTH_FAILED'],
    ['forbidden', 'MODEL_AUTH_FAILED'],
    ['model', 'MODEL_OR_ENDPOINT_NOT_FOUND'],
    ['quota', 'MODEL_RATE_LIMIT'],
    ['server', 'MODEL_SERVICE_FAILED']
  ]) {
    const s = await setup(t, mode)
    await assert.rejects(
      s.operations.ping(s.fixture.config.id, { requestId: 'fixture-' + mode }),
      (error) => {
        assert.equal(error.code, code)
        assert.equal(error.message.includes('fixture-private-error-do-not-echo'), false)
        return true
      }
    )
    assert.equal(s.fixture.requests.length, 1)
  }
})
test('timeout and busy abort actual in-flight request, restore runtime, no automatic retry', async (t) => {
  const s = await setup(t, 'timeout')
  await s.runtime.initialize()
  const first = s.operations.ping(s.fixture.config.id, { requestId: 'fixture-timeout' }, 600)
  const check = assert.rejects(first, { code: 'MODEL_TIMEOUT' })
  await assert.rejects(s.operations.ping(s.fixture.config.id, { requestId: 'fixture-busy' }), {
    code: 'PI_BUSY'
  })
  await check
  const deadline = Date.now() + 3000
  while (s.fixture.active && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(s.fixture.requests.length, 1)
  assert.equal(s.fixture.active, 0)
})
test('network disconnect fails explicitly and does not retry', async (t) => {
  const s = await setup(t, 'network')
  await assert.rejects(s.operations.ping(s.fixture.config.id, { requestId: 'fixture-network' }), {
    code: 'MODEL_NETWORK_FAILED'
  })
  assert.equal(s.fixture.requests.length, 1)
})
test('fixed authenticated /test accepts only saved ID; extra source/prompt refused; request ID survives main client', async (t) => {
  const s = await setup(t, 'auth')
  const server = await startHttpServer('fixture-local-token', {
    testModel: (id, c, signal) => s.operations.ping(id, c, 15000, signal)
  })
  t.after(() => server.close())
  const url = `http://127.0.0.1:${server.port}`
  assert.equal((await fetch(url + '/test', { method: 'POST' })).status, 401)
  const bad = await fetch(url + '/test', {
    method: 'POST',
    headers: { Authorization: 'Bearer fixture-local-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      modelConfigId: s.fixture.config.id,
      message: 'send source',
      projectRoot: 'C:/source'
    })
  })
  assert.equal(bad.status, 400)
  assert.equal(s.fixture.requests.length, 0)
  const result = await postModelTest(server.port, 'fixture-local-token', s.fixture.config.id)
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MODEL_AUTH_FAILED')
  assert.ok(result.requestId)
  assert.equal(s.fixture.requests.length, 1)
})
