import test from 'node:test'
import assert from 'node:assert/strict'
import { createAgentHarness } from './agent-harness.mjs'
import { RecoveryExecution, RunRecoveryStore } from '../src/service/chains/recovery.ts'
import { ApiError } from '../src/shared/api-error.ts'
import { MCP_PROFILE } from '../src/service/mcp/contracts.ts'
import { savedReportSnapshot, renderReportJson } from '../src/service/reports/snapshot.ts'
import { renderSavedReport } from '../src/service/reports/html.ts'

test('real Pi invokes both MCP services; receipts, budgets and source quotes persist through the production pipeline', async (t) => {
  const h = await createAgentHarness(t, 'mcp'),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  const detail = h.repo.detail(scope)
  assert.equal(detail.status, 'unresolved', detail.summary)
  const receipts = h.db.all(`SELECT * FROM tool_receipts WHERE tool_name!='audit_read_step'`)
  assert.equal(receipts.length, 3)
  const events = h.repo.scans.events.list(scope.projectId, scope.runId, scope.pathId).events
  for (const name of ['audit_find_related', 'audit_read_related', 'audit_static_scan'])
    assert.ok(events.some((e) => e.toolName === name && e.status === 'completed'))
  assert.equal(
    JSON.parse(h.db.get('SELECT binding_json FROM path_recovery').binding_json).mcpProfile,
    MCP_PROFILE
  )
  assert.equal(h.db.get('SELECT tools FROM path_recovery').tools, detail.steps.length + 3)
  assert.ok(detail.steps[0].evidence.length)
  const tools = h.model.requests[0].tools.map((t) => t.function.name)
  assert.deepEqual(
    new Set(tools),
    new Set(['audit_read_step', 'audit_find_related', 'audit_read_related', 'audit_static_scan'])
  )
  assert.throws(() =>
    h.db.run("UPDATE tool_receipts SET sha256='bad' WHERE tool_name!='audit_read_step'")
  )
  const requests = h.model.requests.length,
    snapshot = savedReportSnapshot(h.db, h.scope.projectId, h.scope.runId)
  assert.equal(snapshot.mcp.receipts.length, 3)
  assert.equal(snapshot.statistics.dangerous, 0)
  assert.ok(renderSavedReport(snapshot).includes('MCP补证与独立静态发现'))
  assert.equal(JSON.parse(renderReportJson(snapshot, 'mcp-test-report')).mcp.receipts.length, 3)
  assert.equal(h.model.requests.length, requests)
})

test('native finish recovery validates MCP transcripts and reuses the committed tool outputs without another model request', async (t) => {
  const h = await createAgentHarness(t, 'mcp'),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] },
    save = RecoveryExecution.prototype.save
  let crashed = false
  RecoveryExecution.prototype.save = function (manager, host, secret) {
    save.call(this, manager, host, secret)
    if (!crashed && host.action === 'finish') {
      crashed = true
      throw new ApiError('RUN_INTERRUPTED', 'fixture after safe MCP finish', 409)
    }
  }
  t.after(() => {
    RecoveryExecution.prototype.save = save
  })
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  RecoveryExecution.prototype.save = save
  const plan = await h.chains.action('recovery', h.scope),
    requests = h.model.requests.length
  assert.equal(plan.mode, 'native', JSON.stringify(plan))
  await h.chains.action('resume', {
    ...h.scope,
    expectedRecoveryKey: plan.recoveryKey,
    maxPaths: 1
  })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.model.requests.length, requests)
  assert.equal(h.repo.detail(scope).status, 'unresolved')
  assert.equal(
    h.db.get(`SELECT count(*) AS n FROM tool_receipts WHERE tool_name!='audit_read_step'`).n,
    3
  )
})

test('missing safe checkpoint rebuilds from immutable MCP receipts and retains cumulative spending', async (t) => {
  const h = await createAgentHarness(t, 'mcp'),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] },
    save = RecoveryExecution.prototype.save
  RecoveryExecution.prototype.save = () => {
    throw new ApiError('RUN_INTERRUPTED', 'fixture before safe checkpoint', 409)
  }
  t.after(() => {
    RecoveryExecution.prototype.save = save
  })
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  RecoveryExecution.prototype.save = save
  const plan = await h.chains.action('recovery', h.scope),
    priorTools = h.db.get('SELECT tools FROM path_recovery').tools
  assert.equal(plan.mode, 'rebuild', JSON.stringify(plan))
  await h.chains.action('resume', {
    ...h.scope,
    expectedRecoveryKey: plan.recoveryKey,
    maxPaths: 1
  })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail(scope).status, 'unresolved')
  assert.ok(h.db.get('SELECT tools FROM path_recovery').tools >= priorTools)
  assert.equal(
    h.db.get(`SELECT count(*) AS n FROM tool_receipts WHERE tool_name!='audit_read_step'`).n,
    3
  )
})

test('pre-MCP execution bindings keep the old single-tool capability set', async (t) => {
  const binding = RunRecoveryStore.prototype.binding
  RunRecoveryStore.prototype.binding = function (...args) {
    const result = binding.apply(this, args)
    delete result.mcpProfile
    return result
  }
  t.after(() => {
    RunRecoveryStore.prototype.binding = binding
  })
  const h = await createAgentHarness(t, 'finish'),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail(scope).status, 'unresolved')
  assert.deepEqual(
    h.model.requests[0].tools.map((t) => t.function.name),
    ['audit_read_step']
  )
  assert.equal(
    h.db.get(`SELECT count(*) AS n FROM tool_receipts WHERE tool_name!='audit_read_step'`).n,
    0
  )
})

test('MCP shares the existing cumulative tool budget and cannot consume a fresh allowance', async (t) => {
  const h = await createAgentHarness(t, 'mcp', { maxToolCalls: 2 }),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail(scope).status, 'failed')
  assert.equal(h.db.get('SELECT tools FROM path_recovery').tools, 2)
  assert.equal(
    h.db.get(`SELECT count(*) AS n FROM tool_receipts WHERE tool_name!='audit_read_step'`).n,
    0
  )
})
