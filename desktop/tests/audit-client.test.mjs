import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { auditRequest } from '../src/main/audit-client.ts'
import { isAuditData } from '../src/shared/audit-validation.ts'

test('audit transport validates database totals, rejects extra secret fields, preserves errors and refuses arbitrary actions', async (t) => {
  let payload = {
    paths: 2,
    sinks: 1,
    edges: 4,
    dangerous: 0,
    safe: 0,
    unknown: 2,
    pending: 2,
    analyzing: 0,
    completed: 0,
    failed: 0,
    unresolved: 0,
    invalid: 0
  }
  const server = createServer((_q, r) =>
    r.end(JSON.stringify({ ok: true, requestId: 'fixture', data: payload }))
  )
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const get = () =>
    auditRequest(server.address().port, 'test-token', 'statistics', { projectId: 'p', runId: 'r' })
  assert.equal((await get()).ok, true)
  payload = { ...payload, apiKey: 'must-not-pass' }
  const rejected = await get()
  assert.equal(rejected.ok, false)
  assert.equal(JSON.stringify(rejected).includes('must-not-pass'), false)
  assert.equal((await auditRequest(server.address().port, 'x', 'arbitrary-command', {})).ok, false)
  assert.equal(isAuditData('statistics', { ...payload, paths: 5 }), false)
})
