import test from 'node:test'
import assert from 'node:assert/strict'
import { evidenceCards, resolveResultCitations } from '../src/service/chains/evidence-citations.ts'
import { validateResult } from '../src/service/chains/path-analysis.ts'
import { ResultValidationError, publicSubmission } from '../src/service/chains/result-validation.ts'
import { createAgentHarness } from './agent-harness.mjs'
import { parseDecision } from '../src/service/chains/decision-json.ts'
import { nonThinkingPayload } from '../src/service/provider-compat.ts'
import { constantRiskArguments } from '../src/service/chains/constant-arguments.ts'
import { validateTaint } from '../src/service/chains/taint-validation.ts'
import { RecoveryExecution } from '../src/service/chains/recovery.ts'
import { ApiError } from '../src/shared/api-error.ts'

test('a finish checkpoint after a transient retry remains natively recoverable without billing the completed response twice', async (t) => {
  const h = await createAgentHarness(t, 'transient-once'),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  const original = RecoveryExecution.prototype.save
  let crash = true
  t.after(() => {
    RecoveryExecution.prototype.save = original
  })
  RecoveryExecution.prototype.save = function (manager, host, secret) {
    original.call(this, manager, host, secret)
    if (host.action === 'finish' && crash) {
      crash = false
      throw new ApiError('RUN_INTERRUPTED', 'fixture after validated finish', 409)
    }
  }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  const plan = await h.chains.action('recovery', h.scope),
    requests = h.model.requests.length
  assert.equal(plan.mode, 'native')
  await h.chains.action('resume', {
    ...h.scope,
    expectedRecoveryKey: plan.recoveryKey,
    maxPaths: 1
  })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.model.requests.length, requests)
  assert.equal(h.repo.detail(scope).status, 'unresolved')
})

test('constant input requires an exact frozen literal at the sink; variable, forged columns and concatenation do not qualify', () => {
  const source = 'new ProcessBuilder("/usr/bin/id", "-u");'
  const args = ['"/usr/bin/id"', '"-u"'].map((text, index) => ({
    index,
    text,
    filePath: 'A.java',
    startLine: 1,
    endLine: 1,
    startColumn: source.indexOf(text) + 1,
    endColumn: source.indexOf(text) + text.length + 1
  }))
  const edge = { isSink: true, ruleId: 'JAVA-CMD-PROCESS-BUILDER', arguments: args }
  const ev = { filePath: 'A.java', startLine: 1, endLine: 1, text: source }
  assert.equal(constantRiskArguments(edge, ev), true)
  assert.equal(
    constantRiskArguments({ ...edge, arguments: [{ ...args[0], text: 'command' }] }, ev),
    false
  )
  assert.equal(
    constantRiskArguments({ ...edge, arguments: [{ ...args[0], startColumn: 1 }] }, ev),
    false
  )
  assert.equal(
    constantRiskArguments({ ...edge, arguments: [{ ...args[0], text: '"id" + command' }] }, ev),
    false
  )
  const checks = Object.fromEntries(
    ['source', 'argumentMapping', 'assignment', 'returnValue', 'field', 'defense'].map((k) => [
      k,
      { status: 'not_applicable', reason: 'fixed input', quotes: [] }
    ])
  )
  const step = { stepIndex: 0, dangerous: 0, taintIn: [], taintOut: [], checks }
  assert.throws(() => validateTaint(step, source), { code: 'ANALYSIS_TAINT_INVALID' })
  assert.equal(validateTaint(step, source, true), step)
})

test('transient transport failure retries once in the same request/round budgets and keeps uncertain usage visible', async (t) => {
  for (const mode of ['transient-once', 'unavailable']) {
    const h = await createAgentHarness(t, mode)
    const scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
    await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
    await h.chains.analysis.waitForIdle()
    assert.equal(h.repo.detail(scope).status, mode === 'transient-once' ? 'unresolved' : 'failed')
    const history = await h.chains.action('history', scope)
    assert.equal(history.frames.filter((f) => f.event === 'request_info').length, 1)
    assert.ok(
      h.db.get(
        "SELECT count(*) n FROM recovery_requests WHERE path_id=? AND state='uncertain'",
        scope.pathId
      ).n >= 1
    )
    if (mode === 'unavailable') assert.equal(h.model.requests.length, 2)
  }
})

test('user stop during transient retry backoff dispatches no new request and leaves an unknown stage result', async (t) => {
  const h = await createAgentHarness(t, 'transient-once'),
    scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  const deadline = Date.now() + 5000
  while (
    !h.db.get(
      "SELECT count(*) n FROM analysis_events WHERE chain_id=? AND status='request_retry'",
      scope.pathId
    ).n
  ) {
    if (Date.now() > deadline) throw Error('retry feedback timeout')
    await new Promise((r) => setTimeout(r, 10))
  }
  await h.chains.action('stop', h.scope)
  await h.chains.analysis.waitForIdle()
  assert.equal(h.model.requests.length, 1)
  assert.equal(h.repo.detail(scope).verdict, 'unknown')
  assert.equal(h.repo.detail(scope).status, 'unresolved')
})

test('decision decoder only inserts missing closers; data, quotes, duplicates, and invalid commas retain strict semantics', () => {
  const input =
    '{"action":"finish","result":{"steps":[{"stepIndex":0,"reason":"keep } ] \\" text","checks":{"defense":{"status":"absent"}}]}}'
  const parsed = parseDecision(input)
  assert.equal(parsed.repairs.length, 1)
  assert.equal(parsed.decision.result.steps[0].checks.defense.status, 'absent')
  assert.equal(parsed.decision.result.steps[0].reason, 'keep } ] " text')
  assert.throws(
    () => parseDecision('{"action":"finish","action":"continue"}'),
    (e) => e.issue.rule === 'duplicate-key'
  )
  assert.throws(() => parseDecision('{"action":"finish",}'), { code: 'AGENT_DECISION_INVALID' })
  assert.throws(() => parseDecision('{"action":"fin'), { code: 'AGENT_DECISION_INVALID' })
  assert.throws(() => parseDecision('prose {"action":"finish"}'), {
    code: 'AGENT_DECISION_INVALID'
  })
  assert.deepEqual(nonThinkingPayload('https://api.deepseek.com/v1', {}, true).response_format, {
    type: 'json_object'
  })
})

const evidence = {
  filePath: 'Web.java',
  startLine: 11,
  endLine: 13,
  text: 'void export(String filter) {\r\n    return service.search(filter);\r\n}',
  ranges: [
    {
      filePath: 'Web.java',
      startLine: 11,
      endLine: 13,
      text: 'void export(String filter) {\r\n    return service.search(filter);\r\n}'
    }
  ]
}
const input = {
  projectId: 'project',
  runId: 'run',
  pathId: 'path',
  path: { steps: [{ stepIndex: 0 }] },
  evidence: [evidence]
}

test('evidence IDs resolve every citation field from this frozen step without mutating the model answer', () => {
  const cards = evidenceCards(evidence, 0, input)
  assert.equal(cards[1].startLine, 12)
  const value = {
    verdict: 'unknown',
    summary: 'unknown',
    steps: [
      {
        stepIndex: 0,
        dangerous: null,
        reason: 'needs verification',
        quotes: [cards[1].id],
        taintIn: [{ name: 'filter', origin: 'input', quotes: [cards[0].id] }],
        taintOut: [],
        checks: { source: { status: 'supported', reason: 'entry', quotes: [cards[0].id] } }
      }
    ]
  }
  const result = resolveResultCitations(value, input)
  assert.equal(result.steps[0].quotes[0], '    return service.search(filter);')
  assert.equal(result.steps[0].taintIn[0].quotes[0], 'void export(String filter) {')
  assert.equal(result.steps[0].checks.source.quotes[0], 'void export(String filter) {')
  assert.equal(value.steps[0].quotes[0], cards[1].id)
  assert.equal(validateResult(result, input).verdict, 'unknown')
})

test('citations reject other tasks, other steps, invented IDs, and preserve strict raw quote matching', () => {
  const card = evidenceCards(evidence, 0, input)[1]
  const model = (quote) => ({
    verdict: 'unknown',
    summary: 'unknown',
    steps: [{ stepIndex: 0, dangerous: null, reason: 'pending', quotes: [quote] }]
  })
  assert.throws(
    () => resolveResultCitations(model(card.id), { ...input, runId: 'other-run' }),
    (e) => e instanceof ResultValidationError && e.issue.rule === 'registered-citation'
  )
  assert.throws(
    () => resolveResultCitations(model(evidenceCards(evidence, 1, input)[1].id), input),
    { code: 'ANALYSIS_EVIDENCE_INVALID' }
  )
  assert.throws(
    () =>
      validateResult(resolveResultCitations(model('return service.search(input);'), input), input),
    (e) => e.issue.field === 'steps[0].quotes[0]' && e.issue.rule === 'exact-source'
  )
  assert.equal(
    validateResult(resolveResultCitations(model('return service.search(filter);'), input), input)
      .verdict,
    'unknown'
  )
})

test('validation identifies unsafe values without copying rejected text into diagnostics', () => {
  const preview = publicSubmission({
    verdict: 'unknown',
    summary: '中文'.repeat(600),
    reasoning_content: 'hidden-provider-field',
    steps: Array.from({ length: 16 }, (_, i) => ({
      stepIndex: i,
      reason: '中文'.repeat(1000),
      quotes: Array(5).fill('中文'.repeat(1000))
    }))
  })
  assert.ok(Buffer.byteLength(JSON.stringify(preview)) < 3072)
  assert.ok(!JSON.stringify(preview).includes('hidden-provider-field'))
  assert.throws(
    () =>
      validateResult(
        {
          verdict: 'unknown',
          summary: 'x',
          steps: [{ stepIndex: 0, dangerous: true, reason: 'x', quotes: ['secret-do-not-log'] }]
        },
        input
      ),
    (e) =>
      e.issue.field === 'steps[0].dangerous' &&
      !JSON.stringify(e.issue).includes('secret-do-not-log')
  )
})

test('defense effective and absent have distinct semantics and cannot silently turn missing protection into safe', () => {
  const make = (status) => ({
    verdict: 'unknown',
    summary: 'x',
    steps: [
      {
        stepIndex: 0,
        dangerous: null,
        reason: 'x',
        quotes: ['return service.search(filter);'],
        checks: { defense: { status, reason: 'x', quotes: [] } }
      }
    ]
  })
  assert.equal(
    resolveResultCitations(make('effective'), input).steps[0].checks.defense.status,
    'blocked'
  )
  assert.equal(
    resolveResultCitations(make('absent'), input).steps[0].checks.defense.status,
    'not_applicable'
  )
})

test('real Pi retries a bad citation once using the existing source/tools, persists diagnostics and a valid terminal result', async (t) => {
  let submissions = 0
  const h = await createAgentHarness(
    t,
    'finish',
    {},
    {
      transformDecision: (d, { tools }) => {
        submissions++
        for (const step of d.result.steps)
          step.quotes = [
            submissions === 1
              ? 'ev-forged'
              : tools.find((e) => e.stepIndex === step.stepIndex).citations[0].id
          ]
        return d
      }
    }
  )
  const scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail(scope).status, 'unresolved')
  assert.equal(submissions, 2)
  assert.ok(h.repo.detail(scope).steps.every((s) => s.evidence.length))
  const history = await h.chains.action('history', scope)
  const feedback = history.frames.filter((f) => f.event === 'validation_info')
  assert.ok(feedback.some((f) => f.data.details.payload.validation?.rule === 'registered-citation'))
  assert.equal(history.frames.at(-1).event, 'completed')
  assert.equal(h.db.get('SELECT count(*) n FROM path_attempts WHERE path_id=?', scope.pathId).n, 1)
})

test('invalid JSON gets one bounded repair; persistent invented source fails unknown with explicit field and no extra retries', async (t) => {
  for (const malformed of [true, false]) {
    let submissions = 0
    const h = await createAgentHarness(
      t,
      'finish',
      {},
      {
        transformDecision: (d) => {
          submissions++
          if (malformed && submissions === 1) return '{"action":"finish",'
          if (!malformed) d.result.steps[0].quotes = ['fabricated source']
          return d
        }
      }
    )
    const scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
    await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
    await h.chains.analysis.waitForIdle()
    const detail = h.repo.detail(scope)
    assert.equal(submissions, 2)
    assert.equal(detail.status, malformed ? 'unresolved' : 'failed')
    assert.equal(detail.verdict, 'unknown')
    if (!malformed) {
      const history = await h.chains.action('history', scope)
      assert.ok(
        history.frames.some(
          (f) =>
            f.event === 'validation_info' &&
            f.data.details.payload.validation?.field === 'steps[0].quotes[0]'
        )
      )
      assert.equal(history.frames.at(-1).event, 'failed')
    }
  }
})

test('no repair request is sent when the existing request budget is exhausted', async (t) => {
  const h = await createAgentHarness(t, 'badQuote', { maxRequests: 3 })
  const scope = { ...h.scope, pathId: h.prepared.pathIds[0] }
  await h.chains.action('analyze', { ...scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  assert.ok(h.model.requests.length <= 3)
  assert.equal(h.repo.detail(scope).verdict, 'unknown')
})
