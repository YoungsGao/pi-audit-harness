import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { createAgentHarness } from './agent-harness.mjs'
import { ReportService } from '../src/service/reports/service.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { reportRequest } from '../src/main/report-client.ts'
import { verifyReportFile } from '../src/service/reports/files.ts'
import { isReportData } from '../src/shared/report-contracts.ts'

test('authenticated fixed report routes preserve scope and registration; renderer cannot submit file paths, HTML, secrets or open another run', async (t) => {
  const h = await createAgentHarness(t)
  const service = new ReportService(h.db, join(h.root, 'runtime'))
  const server = await startHttpServer('fixture-report-token', {
    reportAction: (action, input, signal) => service.action(action, input, signal)
  })
  t.after(async () => {
    await server.close()
    await service.close()
  })
  const response = await fetch(`http://127.0.0.1:${server.port}/reports/list`, { method: 'POST' })
  assert.equal(response.status, 401)
  const invalid = await reportRequest(server.port, 'fixture-report-token', 'generate', {
    ...h.scope,
    html: 'injected'
  })
  assert.equal(invalid.ok, false)
  assert.equal(h.db.get('SELECT count(*) AS n FROM reports').n, 0)
  const created = await reportRequest(server.port, 'fixture-report-token', 'generate', h.scope)
  assert.equal(created.ok, true)
  assert.equal(created.data.status, 'ready')
  assert.equal(
    isReportData('generate', {
      ...created.data,
      statistics: { ...created.data.statistics, dangerous: 1 }
    }),
    false
  )
  const listed = await reportRequest(server.port, 'fixture-report-token', 'list', h.scope)
  assert.equal(listed.ok, true)
  assert.equal(listed.data.reports[0].reportId, created.data.reportId)
  const file = await reportRequest(server.port, 'fixture-report-token', 'file', {
    ...h.scope,
    reportId: created.data.reportId
  })
  assert.equal(file.ok, true)
  await assert.rejects(
    verifyReportFile(join(h.root, 'runtime'), {
      ...file.data,
      filePath: join(h.root, 'other.html')
    }),
    { code: 'REPORT_UNSAFE_FILE' }
  )
  const wrong = await reportRequest(server.port, 'fixture-report-token', 'file', {
    ...h.scope,
    runId: 'other-run',
    reportId: created.data.reportId
  })
  assert.equal(wrong.ok, false)
  assert.equal(wrong.error.code, 'REPORT_NOT_FOUND')
  assert.equal(h.model.requests.length, 0)
})

test('main report transport rejects a different scope or unexpected sensitive fields even after HTTP 200', async (t) => {
  const scope = { projectId: 'project', runId: 'run' }
  let data = { ...scope, reports: [], apiKey: 'fixture-only-private' }
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ ok: true, requestId: 'fixture-request', data }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  assert.equal((await reportRequest(server.address().port, 'fixture', 'list', scope)).ok, false)
  data = { ...scope, projectId: 'different', reports: [] }
  assert.equal((await reportRequest(server.address().port, 'fixture', 'list', scope)).ok, false)
})
