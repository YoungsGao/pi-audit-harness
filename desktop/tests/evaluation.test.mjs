import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EvaluationService } from '../src/service/evaluation/service.ts'
import { evaluationMetrics } from '../src/shared/evaluation.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { evaluationRequest } from '../src/main/evaluation-client.ts'

test('live evaluation reserves before transport and refuses a budget too small for even one request', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-eval-budget-'))
  const config = {
    id: 'live-fixture',
    name: 'budget test',
    revision: 1,
    baseUrl: 'http://127.0.0.1:1/v1',
    modelId: 'fixture',
    api: 'openai-completions',
    secretRef: 'test-only'
  }
  const service = new EvaluationService(root, {
    getConfig: async () => config,
    readSecret: async () => 'local-test-key'
  })
  t.after(async () => {
    await service.close()
    await rm(root, { recursive: true, force: true })
  })
  const started = await service.action('start', {
    mode: 'live',
    allowPaid: true,
    caseIds: ['jdbc-bound'],
    trials: 1,
    modelConfigId: config.id,
    modelRevision: 1,
    tokenBudget: 1000
  })
  await assert.rejects(
    service.action('start', { mode: 'engineering', caseIds: ['jdbc-bound'], trials: 1 }),
    { code: 'EVAL_BUSY' }
  )
  let job
  do {
    await new Promise((r) => setTimeout(r, 30))
    job = await service.action('detail', { id: started.id })
  } while (job.state === 'running')
  assert.equal(job.state, 'stopped')
  assert.equal(job.errorCode, 'EVAL_TOKEN_BUDGET')
  assert.equal(
    job.rows[0].requests,
    0,
    'no transport is attempted; no connection error is used as the budget mechanism'
  )
  assert.equal(job.reportedUsage + job.uncertainUsage + job.reserved, 0)
})

test('comparison executes real Pi/CodeGraph/Python across three tool sets, persists history and never reports fixture accuracy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-evaluation-')),
    ports = { getConfig: async () => undefined, readSecret: async () => undefined }
  const service = new EvaluationService(root, ports)
  const http = await startHttpServer('evaluation-test-token', {
    evaluationAction: (a, v) => service.action(a, v)
  })
  t.after(async () => {
    await http.close()
    await service.close()
    await rm(root, { recursive: true, force: true })
  })
  const response = await evaluationRequest(http.port, 'evaluation-test-token', 'start', {
    mode: 'engineering',
    caseIds: ['helper-allowlist'],
    trials: 1
  })
  assert.equal(response.ok, true, JSON.stringify(response))
  const { id } = response.data
  const end = Date.now() + 45000
  let job
  do {
    await new Promise((r) => setTimeout(r, 50))
    job = await service.action('detail', { id })
    assert.ok(Date.now() < end, JSON.stringify(job))
  } while (job.state === 'running')
  assert.equal(job.state, 'completed', JSON.stringify(job))
  assert.equal(job.rows.length, 3)
  assert.ok(
    job.rows.every((r) => r.status === 'completed'),
    JSON.stringify(job.rows)
  )
  assert.equal(new Set(job.rows.map((r) => r.sourceDigest)).size, 1)
  assert.ok(job.rows[1].tools > job.rows[0].tools)
  assert.ok(job.rows[2].tools > job.rows[1].tools)
  if (process.env.PI_AUDIT_SEMGREP_PATH)
    assert.equal(job.rows[2].scanStatus, 'ok', JSON.stringify(job.rows[2]))
  assert.ok(
    job.rows[0].trace.every((r) => !r.tool?.includes('related') && !r.tool?.includes('static'))
  )
  assert.equal(evaluationMetrics(job, 'full').agreement, null)
  assert.equal(job.reportedUsage, 0)
  const pending = await service.action('start', {
    mode: 'engineering',
    caseIds: ['jdbc-bound'],
    trials: 1
  })
  const stopped = await service.action('stop', { id: pending.id })
  assert.equal(
    stopped.state,
    'stopped',
    'stop cannot become completed when cancellation arrives near the end'
  )
  assert.equal(stopped.errorCode, 'EVAL_USER_STOP')
  assert.equal((await new EvaluationService(root, ports).action('detail', { id })).rows.length, 3)
  await assert.rejects(
    service.action('start', {
      mode: 'live',
      caseIds: ['jdbc-bound'],
      trials: 1,
      tokenBudget: 50000
    }),
    { code: 'EVAL_CONSENT_REQUIRED' }
  )
  assert.equal((await evaluationRequest(http.port, 'wrong', 'list', {})).ok, false)
})
