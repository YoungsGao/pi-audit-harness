import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAgentHarness } from './agent-harness.mjs'
import { startHttpServer } from '../src/service/http-server.ts'
import { connectAnalyze } from '../src/main/analyze-stream-client.ts'
import { AnalyzeSseParser } from '../src/shared/sse-parser.ts'
import { serveAnalyze } from '../src/service/analyze-http.ts'
import { validateTaint, reconcileTaint } from '../src/service/chains/taint-validation.ts'
import { validateResult } from '../src/service/chains/path-analysis.ts'

async function streamServer(t, h) {
  const api = { open: (v) => h.chains.openStream(v), read: (v) => h.chains.readStream(v) }
  const server = await startHttpServer('fixture-token', { analyzeStream: api })
  t.after(() => server.close())
  return {
    port: server.port,
    input: { ...h.scope, chainId: h.prepared.pathIds[0], modelConfigId: 'model' },
    api
  }
}
test('SSE POST persists ordered per-session frames, reconnect replays original ids without another model call; terminal is per-path', async (t) => {
  const h = await createAgentHarness(t, 'continue', {}, { delayMs: 20 }),
    { port, input } = await streamServer(t, h)
  const frames = [],
    abort = new AbortController()
  const first = await connectAnalyze(
    port,
    'fixture-token',
    input,
    (f) => {
      frames.push(f)
      if (f.id === 2) abort.abort()
    },
    abort.signal
  )
  await first.done.catch(() => {})
  await h.chains.analysis.waitForIdle()
  const before = h.model.requests.length,
    afterId = frames.at(-1).id,
    more = []
  const replay = await connectAnalyze(
    port,
    'fixture-token',
    { ...input, sessionId: first.sessionId, afterId },
    (f) => more.push(f),
    new AbortController().signal
  )
  await replay.done
  assert.equal(h.model.requests.length, before)
  assert.ok(more.every((f) => f.data.sessionId === first.sessionId && f.id > afterId))
  assert.equal(more.at(-1).event, 'completed')
  assert.equal(more.at(-1).data.type, 'result')
  assert.equal(more.at(-1).data.details.payload.verdict, 'unknown')
  const stored = h.repo.scans.streams.list({ ...input, sessionId: first.sessionId }).frames
  assert.deepEqual(
    stored.map((f) => f.id),
    stored.map((_, i) => i + 1)
  )
  assert.deepEqual(stored.slice(afterId), more)
  assert.equal(h.repo.scans.statistics(input.projectId, input.runId).pending, 1)
  const empty = await connectAnalyze(
    port,
    'fixture-token',
    { ...input, sessionId: first.sessionId, afterId: stored.at(-1).id },
    () => assert.fail('no new frames'),
    new AbortController().signal
  )
  await empty.done
})
test('session/cursor ownership and expiry are explicit, old attempt cannot overwrite a new stream', async (t) => {
  const h = await createAgentHarness(t, 'finish'),
    { port, input } = await streamServer(t, h),
    frames = []
  const first = await connectAnalyze(
    port,
    'fixture-token',
    input,
    (f) => frames.push(f),
    new AbortController().signal
  )
  await first.done
  const before = h.model.requests.length
  for (const change of [
    { chainId: h.prepared.pathIds[1] },
    { modelConfigId: 'wrong' },
    { runId: 'wrong' }
  ]) {
    await assert.rejects(
      connectAnalyze(
        port,
        'fixture-token',
        { ...input, ...change, sessionId: first.sessionId },
        () => {},
        new AbortController().signal
      ),
      { code: 'SSE_SESSION_MISMATCH' }
    )
  }
  await assert.rejects(
    connectAnalyze(
      port,
      'fixture-token',
      { ...input, sessionId: first.sessionId, afterId: 9999 },
      () => {},
      new AbortController().signal
    ),
    { code: 'SSE_CURSOR_AHEAD' }
  )
  h.repo.scans.streams.expire(first.sessionId, 2)
  await assert.rejects(
    connectAnalyze(
      port,
      'fixture-token',
      { ...input, sessionId: first.sessionId, afterId: 0 },
      () => {},
      new AbortController().signal
    ),
    { code: 'SSE_HISTORY_EXPIRED' }
  )
  assert.equal(h.model.requests.length, before)
  const retry = h.chains.openStream(input)
  assert.notEqual(retry.sessionId, first.sessionId)
  const current = h.repo.scans.streams.list(retry).frames
  assert.equal(current[0].id, 1)
  assert.equal(current[0].data.attemptId, 2)
  assert.throws(
    () =>
      h.repo.scans.events.append(input.projectId, input.runId, input.chainId, {
        type: 'model',
        status: 'continue',
        attemptId: 1,
        summary: 'late'
      }),
    { code: 'ANALYSIS_STALE' }
  )
  await h.chains.analysis.waitForIdle()
})
test('SSE parser handles UTF-8 and CRLF split at every byte, comments, duplicates and unsafe session/gaps', () => {
  const frame = {
    event: 'queued',
    id: 1,
    data: {
      projectId: 'p',
      runId: 'r',
      chainId: 'c',
      sessionId: 's',
      attemptId: 1,
      type: 'process',
      status: 'queue',
      message: '中文证据',
      summaryMissing: false,
      details: null
    }
  }
  const encoded = new TextEncoder().encode(
    `: ping\r\n\r\nevent: queued\r\nid: 1\r\ndata: ${JSON.stringify(frame.data)}\r\n\r\n`
  )
  const parser = new AnalyzeSseParser(),
    out = []
  for (const b of encoded) out.push(...parser.push(new Uint8Array([b])))
  parser.finish()
  assert.deepEqual(out, [frame])
  assert.deepEqual(
    parser.push(
      new TextEncoder().encode(`event: queued\nid: 1\ndata: ${JSON.stringify(frame.data)}\n\n`)
    ),
    []
  )
  assert.throws(() => new AnalyzeSseParser('another').push(encoded), /SSE_SESSION_MISMATCH/)
  assert.throws(
    () =>
      new AnalyzeSseParser('s').push(
        new TextEncoder().encode(`event: queued\nid: 3\ndata: ${JSON.stringify(frame.data)}\n\n`)
      ),
    /SSE_CURSOR_GAP/
  )
})
test('heartbeat is a comment without ids, disconnect does not create model work, unauthenticated POST is rejected', async (t) => {
  const h = await createAgentHarness(t, 'finish'),
    { port, input, api } = await streamServer(t, h)
  const bad = await fetch(`http://127.0.0.1:${port}/analyze`, { method: 'POST' })
  assert.equal(bad.status, 401)
  const invalid = await fetch(`http://127.0.0.1:${port}/analyze`, {
    method: 'POST',
    headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...input, source: 'injected' })
  })
  assert.equal(invalid.status, 400)
  assert.equal(h.model.requests.length, 0)
  // Short heartbeat interval only in this transport test, with immutable fake persisted session.
  let readCount = 0
  const server = createServer((req, res) => {
    void serveAnalyze(
      req,
      res,
      {
        open: () => ({ ...input, sessionId: 'heartbeat' }),
        read: () => ({ frames: [], terminal: ++readCount > 5 })
      },
      new AbortController().signal,
      1
    )
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const response = await fetch(`http://127.0.0.1:${server.address().port}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  const body = await response.text()
  assert.match(body, /: ping\n\n/)
  assert.ok(!body.includes('id:'))
  assert.equal(h.model.requests.length, 0)
  assert.ok(api)
})
test('no-progress repeats end unresolved with stopped event and reason; taint risk/defense/invalid persist independently', async (t) => {
  const repeat = await createAgentHarness(t, 'tools', { maxNoProgress: 2 })
  const request = { ...repeat.scope, chainId: repeat.prepared.pathIds[0], modelConfigId: 'model' }
  const session = repeat.chains.openStream(request)
  await repeat.chains.analysis.waitForIdle()
  const detail = repeat.repo.detail({ ...repeat.scope, pathId: request.chainId })
  assert.equal(detail.status, 'unresolved')
  assert.equal(detail.verdict, 'unknown')
  assert.match(detail.summary, /AGENT_NO_PROGRESS/)
  assert.equal(repeat.repo.scans.streams.list(session).frames.at(-1).event, 'stopped')
  for (const mode of ['dangerous', 'safe', 'invalid', 'contradiction', 'missing-check']) {
    const h = await createAgentHarness(t, mode)
    const pathId = h.prepared.pathIds[0]
    h.chains.analysis.start(h.scope.projectId, h.scope.runId, pathId, 'model')
    await h.chains.analysis.waitForIdle()
    const path = h.repo.detail({ ...h.scope, pathId }),
      sibling = h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[1] })
    if (['contradiction', 'missing-check'].includes(mode)) {
      assert.equal(path.status, 'failed')
      assert.equal(path.verdict, 'unknown')
    } else if (mode === 'invalid') {
      assert.equal(path.status, 'invalid')
      assert.equal(path.dangerous, null)
    } else {
      assert.equal(path.verdict, mode)
      assert.equal(path.dangerous, mode === 'dangerous' ? 1 : 0)
      assert.ok(
        path.steps.every(
          (s) =>
            s.taintIn.length &&
            s.taintOut.length &&
            s.propagation.argumentMapping.status === 'supported'
        )
      )
      if (mode === 'safe') assert.equal(path.steps.at(-1).dangerous, 0)
    }
    assert.equal(sibling.status, 'pending')
    assert.ok(sibling.steps.every((s) => s.dangerous === null && s.taintIn.length === 0))
  }
})

test('taint source/coverage guards, predecessor references and per-file quotes prevent unsupported risk', () => {
  const source = '@GetMapping("/q") String entry(String q) { return query(q); }'
  const checks = Object.fromEntries(
    ['source', 'argumentMapping', 'assignment', 'returnValue', 'field', 'defense'].map((k) => [
      k,
      {
        status: k === 'defense' ? 'not_applicable' : 'supported',
        reason: '原文核查',
        quotes: k === 'defense' ? [] : [source]
      }
    ])
  )
  const step = {
    stepIndex: 0,
    dangerous: 1,
    reason: 'test',
    quotes: [source],
    taintIn: [{ name: 'q', origin: 'HTTP', quotes: [source] }],
    taintOut: [{ name: 'q', origin: 'argument', quotes: [source] }],
    checks
  }
  validateTaint(step, [source])
  assert.throws(() => validateTaint({ ...step, stepIndex: 1 }, [source]), {
    code: 'ANALYSIS_TAINT_INVALID'
  })
  const result = { verdict: 'dangerous', summary: 'test', steps: [step] }
  assert.equal(reconcileTaint(result, true, 'http-entry-candidate:entry').verdict, 'unknown')
  assert.equal(reconcileTaint(result, false, 'method-boundary:entry').steps[0].dangerous, null)
  const absent = {
    ...step,
    checks: {
      ...checks,
      source: { status: 'not_applicable', reason: '不能确认输入来源', quotes: [] }
    }
  }
  assert.equal(
    reconcileTaint({ ...result, steps: [absent] }, false, 'http-entry-candidate:entry').verdict,
    'unknown'
  )
  const evidence = {
    filePath: 'A.java',
    startLine: 1,
    endLine: 1,
    text: 'A.java:1-1\n' + source,
    ranges: [{ filePath: 'A.java', startLine: 1, endLine: 1, text: source }]
  }
  assert.throws(
    () =>
      validateResult(
        { ...result, steps: [{ ...step, quotes: ['A.java:1-1'] }] },
        { path: { steps: [{}] }, evidence: [evidence] },
        true
      ),
    { code: 'ANALYSIS_EVIDENCE_INVALID' }
  )
  assert.throws(
    () =>
      validateTaint(
        {
          ...step,
          quotes: ['ab'],
          checks: {
            ...checks,
            source: { status: 'supported', reason: 'invalid joined quote', quotes: ['ab'] }
          }
        },
        ['a', 'b']
      ),
    { code: 'ANALYSIS_TAINT_INVALID' }
  )
})

test('stream terminal frame rolls back with business result and crash recovery persists a failure frame', async (t) => {
  const h = await createAgentHarness(t, 'finish'),
    chainId = h.prepared.pathIds[0]
  const attempt = h.repo.scans.claim(h.scope.projectId, h.scope.runId, chainId, 'model')
  const session = h.repo.scans.streams.current(h.scope.projectId, h.scope.runId, chainId)
  h.db.exec(
    "CREATE TRIGGER reject_stream_terminal BEFORE INSERT ON stream_events WHEN NEW.event='completed' BEGIN SELECT RAISE(ABORT,'fixture'); END"
  )
  assert.throws(() =>
    h.repo.scans.complete(
      chainId,
      attempt,
      { verdict: 'unknown', summary: 'test', steps: [] },
      [],
      false
    )
  )
  assert.equal(h.repo.detail({ ...h.scope, pathId: chainId }).status, 'analyzing')
  assert.equal(
    h.db.get('SELECT state FROM analysis_sessions WHERE session_id=?', session.session_id).state,
    'analyze'
  )
  h.db.exec('DROP TRIGGER reject_stream_terminal')
  h.repo.scans.recover()
  const input = { ...h.scope, chainId, modelConfigId: 'model', sessionId: session.session_id }
  assert.equal(h.repo.scans.streams.list(input).frames.at(-1).event, 'failed')
  assert.equal(h.repo.detail({ ...h.scope, pathId: chainId }).verdict, 'unknown')
})
