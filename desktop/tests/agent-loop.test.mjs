import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage, migrations, migrate } from '../src/service/storage/schema.ts'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { ReportRepository } from '../src/service/storage/report-repository.ts'
import { isAuditData } from '../src/shared/audit-validation.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { auditRequest } from '../src/main/audit-client.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'

import { createAgentHarness as fixture, waitDone } from './agent-harness.mjs'

async function batchFixture(t, budgets = {}) {
  const h = await fixture(t, 'batch', budgets)
  const project = await importLocal(new SourceRepository(h.db), {
    projectName: 'three-step batched tool calls',
    path: join(import.meta.dirname, 'fixtures', 'scan-java')
  })
  const prepared = await h.chains.action('prepare', { projectId: project.projectId })
  const scope = { projectId: project.projectId, runId: prepared.runId }
  const input = { ...scope, pathId: prepared.pathIds[0], modelConfigId: 'model' }
  assert.equal(h.repo.detail(input).steps.length, 3)
  return { ...h, scope, input }
}

test('one model response batches three source reads without QUERY_BUSY; all evidence and the terminal result commit', async (t) => {
  const { chains, repo, model, scope, input } = await batchFixture(t)
  await chains.action('analyze', input)
  await chains.analysis.waitForIdle()
  const detail = repo.detail(input)
  assert.equal(detail.status, 'unresolved', detail.summary)
  assert.equal(detail.verdict, 'unknown')
  assert.ok(detail.steps.every((s) => s.evidence.length > 0))
  assert.equal(model.requests.length, 2) // One batched tool request, then one final answer.
  assert.equal(model.requests[1].messages.filter((m) => m.role === 'tool').length, 3)
  const events = repo.scans.events.list(scope.projectId, scope.runId, input.pathId).events
  assert.deepEqual(
    events.filter((e) => e.type === 'tool').map((e) => [e.status, e.payload.input.stepIndex]),
    [
      ['started', 0],
      ['completed', 0],
      ['started', 1],
      ['completed', 1],
      ['started', 2],
      ['completed', 2]
    ]
  )
  const history = await chains.action('history', { ...scope, pathId: input.pathId })
  assert.equal(history.frames.at(-1).event, 'completed')
  assert.equal(repo.scans.statistics(scope.projectId, scope.runId).pending, 1)
})

test('batched tools still enforce the tool budget before reading the third step or requesting the model again', async (t) => {
  const { chains, repo, model, scope, input } = await batchFixture(t, { maxToolCalls: 2 })
  await chains.action('analyze', input)
  await chains.analysis.waitForIdle()
  const detail = repo.detail(input)
  assert.equal(detail.status, 'unresolved')
  assert.match(detail.summary, /AGENT_TOOL_LIMIT/)
  assert.equal(detail.verdict, 'unknown')
  assert.equal(model.requests.length, 1)
  const events = repo.scans.events.list(scope.projectId, scope.runId, input.pathId).events
  assert.deepEqual(
    events
      .filter((e) => e.type === 'tool' && e.status === 'completed')
      .map((e) => e.payload.input.stepIndex),
    [0, 1]
  )
  const history = await chains.action('history', { ...scope, pathId: input.pathId })
  assert.equal(history.frames.at(-1).event, 'stopped')
  assert.equal(repo.scans.statistics(scope.projectId, scope.runId).pending, 1)
})

test('real Pi tool loop serially claims SQLite pending paths, persists decisions/evidence/result events, never trusts client source', async (t) => {
  const { chains, repo, model, scope, db, prepared } = await fixture(t)
  const accepted = await chains.action('analyzePending', { ...scope, modelConfigId: 'model' })
  assert.equal(isAuditData('analyzePending', accepted), true)
  await assert.rejects(chains.action('analyzePending', { ...scope, modelConfigId: 'model' }), {
    code: 'ANALYSIS_BUSY'
  })
  await waitDone(repo, scope)
  const stats = repo.scans.statistics(scope.projectId, scope.runId)
  assert.equal(stats.pending, 0)
  assert.equal(stats.unresolved, 2)
  assert.equal(stats.unknown, 2)
  const state = await chains.action('runState', scope)
  assert.equal(state.stage, 'completed')
  assert.equal(isAuditData('runState', state), true)
  const events = await chains.action('events', scope)
  assert.equal(isAuditData('events', events), true)
  assert.ok(
    events.events.some(
      (e) => e.type === 'model' && e.status === 'continue' && e.summaryMissing && e.summary === null
    )
  )
  assert.ok(
    events.events.some((e) => e.type === 'tool' && e.status === 'completed' && e.durationMs >= 0)
  )
  assert.equal(events.events.filter((e) => e.type === 'result').length, 2)
  const firstEnd = events.events.findIndex((e) => e.type === 'result')
  assert.notEqual(events.events[firstEnd].chainId, events.events[firstEnd + 1].chainId)
  for (const pathId of prepared.pathIds) {
    const detail = repo.detail({ ...scope, pathId })
    assert.deepEqual(
      detail.steps.map((s) => s.stepIndex),
      [0, 1]
    )
    assert.ok(detail.steps.every((s) => s.evidence.length))
  }
  assert.ok(model.requests.length >= 8)
  assert.ok(
    model.requests.every(
      (r) =>
        r.model === 'fixture' &&
        r.tools?.length === 1 &&
        r.tools[0].function.name === 'audit_read_step'
    )
  )
  assert.equal(
    db.get("SELECT count(DISTINCT run_id||':'||seq) AS n FROM analysis_events").n,
    events.events.length
  )
  await assert.rejects(
    chains.action('analyzePending', { ...scope, modelConfigId: 'model', source: 'injected' }),
    { code: 'QUERY_INVALID_INPUT' }
  )
})
test('round/tool/time budgets and scoped tool violations persist failed unknown; remaining queue stays pending', async (t) => {
  for (const [mode, budget, code] of [
    ['rounds', { maxRounds: 2 }, 'AGENT_ROUND_LIMIT'],
    ['tools', { maxToolCalls: 2 }, 'AGENT_TOOL_LIMIT'],
    ['finish', { maxRequests: 1 }, 'AGENT_REQUEST_LIMIT'],
    ['scope', {}, 'AGENT_TOOL_SCOPE'],
    ['hold', { timeoutMs: 150 }, 'MODEL_TIMEOUT'],
    ['badQuote', {}, 'ANALYSIS_EVIDENCE_INVALID']
  ]) {
    const { chains, repo, scope, model } = await fixture(t, mode, budget)
    await chains.action('analyzePending', { ...scope, modelConfigId: 'model' })
    await waitDone(repo, scope)
    const stats = repo.scans.statistics(scope.projectId, scope.runId)
    const limited = /AGENT_(?:ROUND_LIMIT|TOOL_LIMIT|REQUEST_LIMIT)/.test(code)
    assert.equal(limited ? stats.unresolved : stats.failed, 1, mode)
    assert.equal(stats.pending, 1, mode)
    assert.equal(stats.safe, 0)
    const failed = repo
      .list(scope)
      .paths.find((p) => p.status === (limited ? 'unresolved' : 'failed'))
    assert.match(failed.summary, new RegExp(code))
    if (code === 'AGENT_REQUEST_LIMIT') assert.equal(model.requests.length, 1)
  }
})
test('event payload is redacted/bounded, cursor scoped; result/event write rolls back together', async (t) => {
  const { repo, scope, db, prepared } = await fixture(t)
  repo.scans.events.append(scope.projectId, scope.runId, prepared.pathIds[0], {
    type: 'tool',
    status: 'completed',
    payload: { apiKey: 'private', nested: 'Authorization=private', output: 'x'.repeat(30000) }
  })
  const page = repo.scans.events.list(scope.projectId, scope.runId, prepared.pathIds[0], 0, 1)
  assert.equal(page.events[0].truncated, true)
  assert.ok(!JSON.stringify(page).includes('private'))
  assert.equal(page.events[0].summaryMissing, true)
  assert.equal(
    repo.scans.events.list(scope.projectId, scope.runId, null, page.nextSeq).events.length,
    0
  )
  assert.throws(() => repo.scans.events.list(scope.projectId, scope.runId, 'wrong'), {
    code: 'CHAIN_NOT_FOUND'
  })
  const pathId = prepared.pathIds[0],
    attempt = repo.scans.claim(scope.projectId, scope.runId, pathId, 'model')
  db.exec(
    "CREATE TRIGGER reject_final BEFORE INSERT ON analysis_events WHEN NEW.type='result' BEGIN SELECT RAISE(ABORT,'fail'); END"
  )
  assert.throws(() =>
    repo.scans.complete(
      pathId,
      attempt,
      { verdict: 'unknown', summary: 'test', steps: [] },
      [],
      false
    )
  )
  assert.equal(repo.detail({ ...scope, pathId }).status, 'analyzing')
  db.exec('DROP TRIGGER reject_final')
  repo.scans.recover()
  assert.equal(repo.scans.state(scope.projectId, scope.runId).stage, 'interrupted')
  assert.equal(repo.detail({ ...scope, pathId }).verdict, 'unknown')
})
test('reports track generation, verified output file and transaction statistics snapshots; pending recovery is explicit', async (t) => {
  const { root, db, scope, repo } = await fixture(t),
    reports = new ReportRepository(db),
    file = join(root, 'report.html')
  const id = reports.begin(scope.projectId, scope.runId, file)
  await assert.rejects(reports.finish(id), { code: 'REPORT_FILE_MISSING' })
  await writeFile(file, '<html>offline report fixture</html>')
  await reports.finish(id)
  const ready = reports.list(scope.projectId, scope.runId).reports[0]
  assert.equal(ready.status, 'ready')
  assert.deepEqual(ready.statistics, {
    ...repo.scans.statistics(scope.projectId, scope.runId),
    riskPoints: null
  })
  reports.begin(scope.projectId, scope.runId, join(root, 'unfinished.html'))
  reports.recover()
  assert.equal(
    db.get("SELECT error_message FROM reports WHERE status='failed'").error_message,
    'REPORT_INTERRUPTED'
  )
})
test('v6 upgrade preserves checksums and historical graph; failed v9 migration leaves v8 intact', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-agent-migration-')),
    db = new LocalDatabase(root)
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  migrate(db, migrations.slice(0, 6))
  const before = db.all('SELECT checksum FROM schema_migrations ORDER BY version')
  migrate(db)
  assert.deepEqual(
    db.all('SELECT checksum FROM schema_migrations WHERE version<=6 ORDER BY version'),
    before
  )
  assert.throws(() =>
    migrate(db, [
      ...migrations,
      { version: 9, name: 'broken', sql: 'CREATE TABLE rollback_me(id); SELECT * FROM absent;' }
    ])
  )
  assert.equal(db.get('PRAGMA user_version').user_version, 8)
  assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='rollback_me'"), undefined)
})

test('fixed authenticated queue/state/event endpoints preserve scope and cursor; source mutation fails instead of using stale evidence', async (t) => {
  const { chains, repo, scope, source, model } = await fixture(t)
  const server = await startHttpServer('local-fixture-token', {
    chainAction: (action, input, signal) => chains.action(action, input, signal)
  })
  t.after(() => server.close())
  const denied = await fetch(`http://127.0.0.1:${server.port}/chains/events`, { method: 'POST' })
  assert.equal(denied.status, 401)
  const start = await auditRequest(server.port, 'local-fixture-token', 'analyzePending', {
    ...scope,
    modelConfigId: 'model',
    maxPaths: 1
  })
  assert.equal(start.ok, true)
  await chains.analysis.waitForIdle()
  const state = await auditRequest(server.port, 'local-fixture-token', 'runState', scope)
  assert.equal(state.ok, true)
  assert.equal(state.data.statistics.pending, 1)
  const first = await auditRequest(server.port, 'local-fixture-token', 'events', {
    ...scope,
    limit: 2
  })
  assert.equal(first.ok, true)
  assert.equal(first.data.events.length, 2)
  const next = await auditRequest(server.port, 'local-fixture-token', 'events', {
    ...scope,
    afterSeq: first.data.nextSeq
  })
  assert.equal(next.ok, true)
  assert.ok(next.data.events.every((e) => e.seq > first.data.nextSeq))
  const before = model.requests.length
  await writeFile(join(source, 'Changed.java'), 'class Changed {}')
  await chains.action('analyzePending', { ...scope, modelConfigId: 'model' })
  await chains.analysis.waitForIdle()
  assert.equal(repo.scans.statistics(scope.projectId, scope.runId).failed, 1)
  assert.equal(repo.scans.statistics(scope.projectId, scope.runId).safe, 0)
  assert.ok(model.requests.length <= before + 1)
  assert.ok(repo.list(scope).paths.some((p) => p.summary.includes('QUERY_SOURCE_CHANGED')))
})

test('two SQLite connections claim different pending rows, explicit retry increments attempt and stale result is rejected', async (t) => {
  const { db, scope, root, repo } = await fixture(t)
  const other = openStorage(join(root, 'runtime')),
    second = new CallChainRepository(other)
  try {
    const first = repo.scans.claimNext(scope.projectId, scope.runId, 'model')
    const next = second.scans.claimNext(scope.projectId, scope.runId, 'model')
    assert.notEqual(first.pathId, next.pathId)
    assert.equal(second.scans.claimNext(scope.projectId, scope.runId, 'model'), null)
    repo.scans.analysisFailed(first.pathId, first.attempt, 'FIXTURE_FAILURE')
    const retry = second.scans.claim(scope.projectId, scope.runId, first.pathId, 'model')
    assert.equal(retry, first.attempt + 1)
    assert.throws(
      () =>
        repo.scans.complete(
          first.pathId,
          first.attempt,
          { verdict: 'unknown', summary: 'late', steps: [] },
          [],
          false
        ),
      { code: 'ANALYSIS_STALE' }
    )
    assert.equal(
      db.get('SELECT attempt FROM path_attempts WHERE path_id=?', first.pathId).attempt,
      retry
    )
  } finally {
    other.close()
  }
})
