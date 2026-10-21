import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { PiOperations } from '../src/service/pi-operations.ts'
import { readWorkItemEvidence } from '../src/service/pi/extensions/audit.ts'
import { createEnv02Fixture } from './env02-fixture.mjs'

test('ping 与审计共用配置，真实 SDK 调用实际证据工具，report 命令生成转义 HTML', async () => {
  const fixture = await createEnv02Fixture()
  const runtime = new PiRuntime(fixture.directory)
  const operations = new PiOperations(runtime, fixture.ports)
  const context = { requestId: 'request-audit', projectId: 'project-test', runId: 'run-test' }
  const work = {
    projectId: context.projectId,
    runId: context.runId,
    projectRoot: fixture.projectRoot,
    file: 'Demo.java',
    startLine: 1,
    endLine: 3
  }
  try {
    const ping = await operations.ping(fixture.config.id, { requestId: 'request-ping' })
    assert.equal(ping.reply, '本机测试回复')
    assert.equal(fixture.requests.length, 1)
    assert.equal(fixture.requests[0].tools?.length ?? 0, 0)
    const audit = await operations.auditPreview(fixture.config.id, context, work)
    assert.deepEqual(ping.model, audit.model)
    assert.equal(audit.evidence.length, 1)
    assert.equal(
      audit.evidence[0].content,
      (await readFile(fixture.projectRoot + '/Demo.java', 'utf8')).trimEnd()
    )
    assert.equal(fixture.requests.length, 3)
    const report = await operations.reportPreview(
      fixture.config.id,
      { ...context, requestId: 'request-report' },
      { ...audit, summary: '<script>alert(1)</script>' }
    )
    assert.ok(report.html.includes('&lt;script&gt;'))
    assert.equal(report.html.includes('<script>'), false)
    assert.equal(report.html.includes('fixture-key-not-a-real-secret'), false)
    assert.equal(fixture.requests.length, 3)
    assert.equal(report.runId, context.runId)
    await assert.rejects(
      readWorkItemEvidence({ ...work, file: '../outside.java' }),
      (error) => error.code === 'SOURCE_OUT_OF_SCOPE'
    )
  } finally {
    await runtime.close()
    await fixture.close()
  }
})

test('运行时超时与重复请求互斥', async () => {
  const fixture = await createEnv02Fixture({ holdReply: true })
  const runtime = new PiRuntime(fixture.directory)
  const operations = new PiOperations(runtime, fixture.ports)
  try {
    await runtime.initialize()
    const first = operations.ping(fixture.config.id, { requestId: 'request-timeout' }, 500)
    const timeoutCheck = assert.rejects(first, (error) => error.code === 'MODEL_TIMEOUT')
    await assert.rejects(
      operations.ping(fixture.config.id, { requestId: 'request-busy' }),
      (error) => error.code === 'PI_BUSY'
    )
    await timeoutCheck
    await runtime.close()
    assert.equal(runtime.getStatus().state, 'stopped')
  } finally {
    await runtime.close()
    await fixture.close()
  }
})

test('停止会取消正在等待回复的 SDK 请求', async () => {
  const fixture = await createEnv02Fixture({ holdReply: true })
  const runtime = new PiRuntime(fixture.directory)
  const operations = new PiOperations(runtime, fixture.ports)
  try {
    const pending = operations.ping(fixture.config.id, { requestId: 'request-stop' }, 10000)
    const cancelled = assert.rejects(pending, (error) => error.code === 'CANCELLED')
    const deadline = Date.now() + 5000
    while (fixture.requests.length === 0 && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(fixture.requests.length, 1)
    await runtime.close()
    await cancelled
    assert.equal(runtime.getStatus().state, 'stopped')
  } finally {
    await runtime.close()
    await fixture.close()
  }
})

test('供应商鉴权、404 与限流错误保留类别并隐藏原始文本', async () => {
  for (const [errorStatus, code] of [
    [401, 'MODEL_AUTH_FAILED'],
    [404, 'MODEL_OR_ENDPOINT_NOT_FOUND'],
    [429, 'MODEL_RATE_LIMIT']
  ]) {
    const fixture = await createEnv02Fixture({ errorStatus })
    const runtime = new PiRuntime(fixture.directory)
    try {
      await assert.rejects(
        new PiOperations(runtime, fixture.ports).ping(fixture.config.id, {
          requestId: 'request-error'
        }),
        (error) => {
          assert.equal(error.code, code)
          assert.equal(error.message.includes('fixture-secret-must-not-leak'), false)
          return true
        }
      )
      assert.equal(fixture.requests.length, 1)
    } finally {
      await runtime.close()
      await fixture.close()
    }
  }
})
