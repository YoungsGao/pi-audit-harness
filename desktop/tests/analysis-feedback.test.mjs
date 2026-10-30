import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentHarness } from './agent-harness.mjs'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { ReportRepository } from '../src/service/storage/report-repository.ts'
import { connectAnalyze } from '../src/main/analyze-stream-client.ts'
import { ApiError } from '../src/shared/api-error.ts'
import { isAuditData } from '../src/shared/audit-validation.ts'
import { mergeAnalysisFrames } from '../src/shared/analysis-view.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { auditRequest } from '../src/main/audit-client.ts'

test('read-only scoped history paginates, survives expiry, separates attempts and passes the main DTO boundary without model calls', async (t) => {
  const h = await createAgentHarness(t),
    pathId = h.prepared.pathIds[0]
  const input = { ...h.scope, pathId }
  const empty = await h.chains.action('history', input)
  assert.equal(empty.sessions.length, 0)
  assert.equal(isAuditData('history', empty), true)
  const attempt = h.repo.scans.claim(h.scope.projectId, h.scope.runId, pathId, 'model')
  for (let i = 0; i < 70; i++)
    h.repo.scans.events.append(h.scope.projectId, h.scope.runId, pathId, {
      type: 'tool',
      status: 'completed',
      attemptId: attempt,
      summary: 'fixture evidence ' + i
    })
  h.repo.scans.analysisFailed(pathId, attempt, 'MODEL_TIMEOUT')
  const first = await h.chains.action('history', input)
  assert.equal(first.frames.length, 50)
  assert.equal(first.hasMore, true)
  assert.equal(isAuditData('history', first), true)
  const second = await h.chains.action('history', {
    ...input,
    sessionId: first.selectedSessionId,
    afterId: first.nextAfterId
  })
  assert.equal(second.frames[0].id, 51)
  assert.equal(second.frames.at(-1).event, 'timed_out')
  assert.equal(second.hasMore, false)
  assert.equal(isAuditData('history', second), true)
  assert.equal(
    isAuditData('history', {
      ...second,
      frames: [
        { ...second.frames[0], data: { ...second.frames[0].data, chainId: h.prepared.pathIds[1] } }
      ]
    }),
    false
  )
  h.repo.scans.streams.expire(first.selectedSessionId, 10)
  const retained = await h.chains.action('history', input)
  assert.equal(retained.historyExpired, true)
  assert.equal(retained.frames[0].id, 11)
  assert.equal(isAuditData('history', retained), true)
  const retry = h.repo.scans.claim(h.scope.projectId, h.scope.runId, pathId, 'model')
  h.repo.scans.analysisFailed(pathId, retry, 'MODEL_UNREACHABLE')
  const latest = await h.chains.action('history', input)
  assert.equal(latest.sessions.length, 2)
  assert.equal(latest.sessions[0].attemptId, 2)
  assert.ok(latest.frames.every((f) => f.data.attemptId === 2))
  const old = await h.chains.action('history', { ...input, sessionId: first.selectedSessionId })
  assert.ok(old.frames.every((f) => f.data.attemptId === 1))
  await assert.rejects(
    h.chains.action('history', {
      ...input,
      pathId: h.prepared.pathIds[1],
      sessionId: first.selectedSessionId
    }),
    { code: 'SSE_SESSION_MISMATCH' }
  )
  await assert.rejects(h.chains.action('history', { ...input, afterId: '1' }), {
    code: 'SSE_INVALID_CURSOR'
  })
  await assert.rejects(h.chains.action('history', { ...input, runId: 'wrong' }), {
    code: 'CHAIN_NOT_FOUND'
  })
  const server = await startHttpServer('fixture-token', {
    chainAction: (a, v) => h.chains.action(a, v)
  })
  t.after(() => server.close())
  const dto = await auditRequest(server.port, 'fixture-token', 'history', input)
  assert.equal(dto.ok, true)
  assert.deepEqual(dto.data, latest)
  assert.equal(h.model.requests.length, 0)
  assert.equal(h.repo.scans.runs(h.scope.projectId).runs[0].errorCode, 'MODEL_UNREACHABLE')
})

test('UI event merger deduplicates session/event identity and refuses cross-chain, cross-run and prior-attempt frames', async (t) => {
  const h = await createAgentHarness(t),
    chainId = h.prepared.pathIds[0]
  const attempt = h.repo.scans.claim(h.scope.projectId, h.scope.runId, chainId, 'model')
  h.repo.scans.analysisFailed(chainId, attempt, 'MODEL_TIMEOUT')
  const history = await h.chains.action('history', { ...h.scope, pathId: chainId })
  const f = history.frames[0],
    scope = { ...h.scope, chainId }
  const incoming = [
    f,
    ...history.frames,
    { ...f, id: 99, data: { ...f.data, chainId: 'other' } },
    { ...f, id: 100, data: { ...f.data, sessionId: 'other' } },
    { ...f, id: 101, data: { ...f.data, runId: 'other' } }
  ]
  assert.deepEqual(
    mergeAnalysisFrames(history.frames, incoming, scope, history.selectedSessionId),
    history.frames
  )
  const many = Array.from({ length: 300 }, (_, i) => ({ ...f, id: i + 1 }))
  const bounded = mergeAnalysisFrames([], many, scope, history.selectedSessionId)
  assert.equal(bounded.length, 200)
  assert.equal(bounded[0].id, 101)
})

test('SSE terminal header cannot make partial or empty fresh streams successful; parser failures retain their category', async (t) => {
  const h = await createAgentHarness(t),
    chainId = h.prepared.pathIds[0]
  const attempt = h.repo.scans.claim(h.scope.projectId, h.scope.runId, chainId, 'model')
  h.repo.scans.analysisFailed(chainId, attempt, 'MODEL_TIMEOUT')
  const history = await h.chains.action('history', { ...h.scope, pathId: chainId })
  const f = history.frames[0]
  let wire = `event: ${f.event}\nid: ${f.id}\ndata: ${JSON.stringify(f.data)}\n\n`
  const server = createServer((_req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'X-Session-Id': history.selectedSessionId,
      'X-Stream-Terminal': 'true',
      'X-Stream-Last-Event-Id': String(history.nextAfterId)
    })
    res.end(wire)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => new Promise((r) => server.close(r)))
  const input = { ...h.scope, chainId, modelConfigId: 'model' }
  async function run(extra = {}) {
    return connectAnalyze(
      server.address().port,
      'fixture',
      { ...input, ...extra },
      () => {},
      new AbortController().signal
    )
  }
  await assert.rejects((await run()).done, { code: 'SSE_DISCONNECTED' })
  wire = ''
  await assert.rejects((await run()).done, { code: 'SSE_DISCONNECTED' })
  await (
    await run({ sessionId: history.selectedSessionId, afterId: history.nextAfterId })
  ).done
  wire = 'event: queued\nid: 1\ndata: {broken}\n\n'
  await assert.rejects((await run()).done, { code: 'SSE_PARSE_FAILED' })
  wire = `event: queued\nid: 4\ndata: ${JSON.stringify(f.data)}\n\n`
  await assert.rejects((await run()).done, { code: 'SSE_CURSOR_GAP' })
})

test('transient result writes retry at most three times without another Pi request; committed reports and previous sessions remain immutable', async (t) => {
  const h = await createAgentHarness(t),
    pathId = h.prepared.pathIds[0]
  let writes = 0
  const complete = h.repo.scans.complete.bind(h.repo.scans)
  h.repo.scans.complete = (...args) => {
    if (++writes <= 2) throw new ApiError('DB_QUERY_FAILED', 'fixture transient lock')
    return complete(...args)
  }
  h.chains.analysis.start(h.scope.projectId, h.scope.runId, pathId, 'model')
  await h.chains.analysis.waitForIdle()
  assert.equal(writes, 3)
  assert.equal(h.model.requests.length, 4)
  assert.equal(h.repo.detail({ ...h.scope, pathId }).status, 'unresolved')
  const old = await h.chains.action('history', { ...h.scope, pathId })
  const reports = new ReportRepository(h.db),
    file = join(h.root, 'report.html')
  const report = reports.begin(h.scope.projectId, h.scope.runId, file)
  await writeFile(file, '<html>historical report</html>')
  await reports.finish(report)
  const snapshot = h.db.get('SELECT * FROM reports WHERE id=?', report)
  h.chains.analysis.start(h.scope.projectId, h.scope.runId, pathId, 'model')
  await h.chains.analysis.waitForIdle()
  const retried = await h.chains.action('history', { ...h.scope, pathId })
  assert.notEqual(retried.selectedSessionId, old.selectedSessionId)
  assert.deepEqual(
    (await h.chains.action('history', { ...h.scope, pathId, sessionId: old.selectedSessionId }))
      .frames,
    old.frames
  )
  assert.deepEqual(h.db.get('SELECT * FROM reports WHERE id=?', report), snapshot)
  const newRun = await h.chains.action('prepare', { projectId: h.scope.projectId })
  assert.notEqual(newRun.runId, h.scope.runId)
  await writeFile(join(h.source, 'Demo.java'), 'class Demo { void changed() {} }')
  h.chains.analysis.start(h.scope.projectId, newRun.runId, newRun.pathIds[0], 'model')
  await h.chains.analysis.waitForIdle()
  assert.doesNotMatch(
    h.repo.detail({ projectId: h.scope.projectId, runId: newRun.runId, pathId: newRun.pathIds[0] })
      .summary,
    /SOURCE_CHANGED/
  )
  assert.deepEqual(h.db.get('SELECT * FROM reports WHERE id=?', report), snapshot)
})

test('persistent result transaction failure rolls back success, persists failed unknown and stops the queue', async (t) => {
  const h = await createAgentHarness(t)
  h.db.exec(
    "CREATE TRIGGER reject_success BEFORE INSERT ON stream_events WHEN NEW.event='completed' BEGIN SELECT RAISE(ABORT,'fixture'); END"
  )
  h.chains.analysis.startPending(h.scope.projectId, h.scope.runId, 'model', 10)
  await h.chains.analysis.waitForIdle()
  const stats = h.repo.scans.statistics(h.scope.projectId, h.scope.runId)
  assert.equal(stats.failed, 1)
  assert.equal(stats.pending, 1)
  assert.equal(stats.analyzing, 0)
  assert.equal(stats.safe, 0)
  assert.equal(h.db.get("SELECT count(*) AS n FROM stream_events WHERE event='completed'").n, 0)
  const failedPath = h.repo.list(h.scope).paths.find((p) => p.status === 'failed').pathId
  const history = await h.chains.action('history', { ...h.scope, pathId: failedPath })
  assert.equal(history.frames.at(-1).event, 'failed')
  assert.equal(history.frames.at(-1).data.details.payload.errorCode, 'DB_QUERY_FAILED')
  assert.equal(h.model.requests.length, 4)
})

test('unwritable failure state yields explicit runtime persistence fault, no unhandled rejection or false terminal; restart recovery settles it', async (t) => {
  const h = await createAgentHarness(t)
  let claims = 0
  const claimNext = h.repo.scans.claimNext.bind(h.repo.scans)
  h.repo.scans.claimNext = (...args) => {
    claims++
    return claimNext(...args)
  }
  h.chains.analysis = new PathAnalysisService(h.repo, h.query, async (input) => {
    h.db.exec(
      "CREATE TRIGGER reject_events BEFORE INSERT ON stream_events BEGIN SELECT RAISE(ABORT,'fixture disk unavailable'); END"
    )
    return {
      verdict: 'unknown',
      summary: 'fixture',
      steps: input.evidence.map((e, stepIndex) => ({
        stepIndex,
        dangerous: null,
        reason: 'unknown',
        quotes: [e.text]
      }))
    }
  })
  h.chains.analysis.startPending(h.scope.projectId, h.scope.runId, 'model')
  await h.chains.analysis.waitForIdle()
  assert.equal(claims, 1)
  const pathId = h.repo.list(h.scope).paths.find((p) => p.status === 'analyzing').pathId
  const session = h.repo.scans.streams.current(h.scope.projectId, h.scope.runId, pathId)
  await assert.rejects(h.chains.action('runState', h.scope), {
    code: 'ANALYSIS_PERSISTENCE_FAILED'
  })
  await assert.rejects(h.chains.action('history', { ...h.scope, pathId }), {
    code: 'ANALYSIS_PERSISTENCE_FAILED'
  })
  assert.throws(
    () =>
      h.chains.readStream({
        ...h.scope,
        chainId: pathId,
        modelConfigId: 'model',
        sessionId: session.session_id
      }),
    { code: 'ANALYSIS_PERSISTENCE_FAILED' }
  )
  assert.throws(() => h.chains.analysis.start(h.scope.projectId, h.scope.runId, pathId, 'model'), {
    code: 'ANALYSIS_PERSISTENCE_FAILED'
  })
  assert.equal(h.repo.detail({ ...h.scope, pathId }).status, 'analyzing') // Honest DB state, explicitly marked unconfirmed by the service.
  assert.equal(
    h.db.get("SELECT count(*) AS n FROM stream_events WHERE event IN ('completed','failed')").n,
    0
  )
  h.db.exec('DROP TRIGGER reject_events')
  h.repo.scans.recover()
  const restarted = new CallChainService(h.repo, h.query)
  const recovered = await restarted.action('history', { ...h.scope, pathId })
  assert.equal(recovered.frames.at(-1).event, 'failed')
  assert.equal(h.repo.detail({ ...h.scope, pathId }).status, 'unresolved')
  assert.equal(h.repo.scans.statistics(h.scope.projectId, h.scope.runId).pending, 1)
})

test('unreachable model ends failed unknown with correlated ids and no automatic model retry', async (t) => {
  const h = await createAgentHarness(t, 'unavailable')
  h.chains.analysis.startPending(h.scope.projectId, h.scope.runId, 'model', 10)
  await h.chains.analysis.waitForIdle()
  const pathId = h.repo.list(h.scope).paths.find((p) => p.status === 'failed').pathId
  const history = await h.chains.action('history', { ...h.scope, pathId })
  const final = history.frames.at(-1)
  assert.equal(final.event, 'failed')
  assert.equal(final.data.chainId, pathId)
  assert.equal(final.data.projectId, h.scope.projectId)
  assert.equal(final.data.runId, h.scope.runId)
  assert.equal(h.repo.detail({ ...h.scope, pathId }).verdict, 'unknown')
  assert.equal(h.repo.scans.statistics(h.scope.projectId, h.scope.runId).pending, 1)
  assert.equal(h.model.requests.length, 1)
})

test('scan failure records a distinct run and correlated scope; unavailable failure storage is explicit until restart recovery', async (t) => {
  const h = await createAgentHarness(t)
  await writeFile(join(h.source, 'Demo.java'), 'class Demo { void changed() {} }')
  await assert.rejects(h.chains.action('prepare', { projectId: h.scope.projectId }), (e) => {
    assert.match(e.message, /projectId=.*runId=.*chainId=尚未生成/)
    return /SOURCE_CHANGED/.test(e.code)
  })
  const failed = h.repo.scans.runs(h.scope.projectId).runs.find((r) => r.state === 'failed')
  assert.notEqual(failed.runId, h.scope.runId)
  assert.equal(h.repo.scans.state(h.scope.projectId, failed.runId).stage, 'failed')
  h.db.exec(
    "CREATE TRIGGER reject_scan_failure BEFORE UPDATE ON scan_runs WHEN NEW.state='failed' BEGIN SELECT RAISE(ABORT,'fixture'); END"
  )
  await assert.rejects(h.chains.action('prepare', { projectId: h.scope.projectId }), {
    code: 'SCAN_PERSISTENCE_FAILED'
  })
  const stuck = h.repo.scans.runs(h.scope.projectId).runs.find((r) => r.state === 'scanning')
  await assert.rejects(
    h.chains.action('runState', { projectId: h.scope.projectId, runId: stuck.runId }),
    { code: 'SCAN_PERSISTENCE_FAILED' }
  )
  await assert.rejects(h.chains.action('prepare', { projectId: h.scope.projectId }), {
    code: 'SCAN_PERSISTENCE_FAILED'
  })
  h.db.exec('DROP TRIGGER reject_scan_failure')
  h.repo.scans.recover()
  assert.equal(h.repo.scans.state(h.scope.projectId, stuck.runId).stage, 'interrupted')
  assert.equal(
    h.repo.scans.runs(h.scope.projectId).runs.find((r) => r.runId === h.scope.runId).state,
    'ready'
  )
})
