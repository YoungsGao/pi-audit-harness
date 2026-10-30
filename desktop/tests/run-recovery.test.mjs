import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentHarness } from './agent-harness.mjs'
import { RecoveryExecution } from '../src/service/chains/recovery.ts'
import { ApiError } from '../src/shared/api-error.ts'
import { isRunRecoveryView, runControlInput } from '../src/shared/run-contracts.ts'
import { isAuditData } from '../src/shared/audit-validation.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { auditRequest } from '../src/main/audit-client.ts'
import { fork } from 'node:child_process'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { migrations, migrate } from '../src/service/storage/schema.ts'
import { ReportService } from '../src/service/reports/service.ts'

const pause = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(check) {
  const end = Date.now() + 15000
  while (!(await check())) {
    if (Date.now() > end) throw Error('fixture timeout')
    await pause(15)
  }
}
async function boundary(t, options = {}) {
  const h = await createAgentHarness(t, 'continue', options)
  const save = RecoveryExecution.prototype.save
  RecoveryExecution.prototype.save = function (manager, host, secret) {
    save.call(this, manager, host, secret)
    if (host.action === 'continue')
      throw new ApiError('RUN_INTERRUPTED', 'fixture crash after safe checkpoint', 409)
  }
  t.after(() => {
    RecoveryExecution.prototype.save = save
  })
  const input = { ...h.scope, pathId: h.prepared.pathIds[0], modelConfigId: 'model' }
  await h.chains.action('analyze', input)
  await h.chains.analysis.waitForIdle()
  RecoveryExecution.prototype.save = save
  return { ...h, input, plan: await h.chains.action('recovery', h.scope) }
}

test('RUN-02 real Pi opens a native safe checkpoint, restores host evidence and budgets, and commits the interrupted path once', async (t) => {
  const h = await boundary(t)
  assert.equal(isRunRecoveryView(h.plan), true)
  assert.equal(isAuditData('recovery', h.plan), true)
  assert.equal(h.plan.mode, 'native', JSON.stringify(h.plan))
  assert.equal(h.plan.canResume, true)
  assert.equal(h.plan.readSteps.length, 2)
  const before = h.model.requests.length
  const cp = h.db.get('SELECT * FROM recovery_checkpoints ORDER BY rowid DESC LIMIT 1')
  const oldBytes = await readFile(join(h.root, 'runtime', 'recovery', cp.file_name), 'utf8')
  assert.ok(!oldBytes.includes('local-fixture-key'))
  await writeFile(join(h.source, 'Demo.java'), 'class ChangedOnDisk {}')
  await h.chains.action('resume', {
    ...h.scope,
    expectedRecoveryKey: h.plan.recoveryKey,
    maxPaths: 1
  })
  await h.chains.analysis.waitForIdle()
  const detail = h.repo.detail(h.input)
  assert.equal(detail.status, 'unresolved', detail.summary)
  assert.ok(detail.steps.every((s) => s.evidence.length > 0))
  assert.equal(h.model.requests.length, before + 1)
  assert.equal(h.model.requests.at(-1).messages.filter((m) => m.role === 'tool').length, 2)
  assert.equal(
    h.db.get('SELECT state,epoch,attempt FROM path_recovery WHERE path_id=?', h.input.pathId).state,
    'completed'
  )
  assert.equal(
    h.db.get('SELECT attempt FROM path_attempts WHERE path_id=?', h.input.pathId).attempt,
    2
  )
  assert.equal(await readFile(join(h.root, 'runtime', 'recovery', cp.file_name), 'utf8'), oldBytes)
  const after = await h.chains.action('recovery', h.scope)
  assert.equal(after.committedPaths, 1)
  assert.equal(after.canResume, true)
  assert.notEqual(after.candidatePathId, h.input.pathId)
  assert.equal(after.lastRecovery.mode, 'native')
  const count = h.model.requests.length
  await assert.rejects(
    h.chains.action('resume', { ...h.scope, expectedRecoveryKey: h.plan.recoveryKey, maxPaths: 1 }),
    { code: 'RUN_PLAN_CHANGED' }
  )
  assert.equal(h.model.requests.length, count)
  const history = await h.chains.action('history', { ...h.scope, pathId: h.input.pathId })
  assert.equal(history.sessions.length, 2)
  const replay = await h.chains.action('history', {
    ...h.scope,
    pathId: h.input.pathId,
    sessionId: history.sessions[1].sessionId
  })
  assert.equal(replay.frames.at(-1).event, 'failed')
  assert.equal(h.model.requests.length, count)
})

test('RUN-01 explicit stop persists acceptance and stopped state, cancels Pi without new work, and leaves unfinished risk unknown', async (t) => {
  const h = await createAgentHarness(t, 'hold')
  const input = { ...h.scope, pathId: h.prepared.pathIds[0], modelConfigId: 'model' }
  await h.chains.action('analyze', input)
  await until(() => h.model.requests.length === 1)
  const accepted = await h.chains.action('stop', h.scope)
  assert.ok(['stop_requested', 'waiting_external'].includes(accepted.state))
  await h.chains.analysis.waitForIdle()
  const stopped = await h.chains.action('recovery', h.scope)
  assert.equal(stopped.state, 'stopped')
  assert.equal(stopped.mode, 'restart')
  assert.equal(stopped.uncertainRequests, 1)
  assert.equal(stopped.requestsUsed, 1)
  assert.equal(stopped.canResume, true)
  assert.equal(h.repo.detail(input).verdict, 'unknown')
  assert.equal((await h.chains.action('runState', h.scope)).stage, 'interrupted')
  assert.equal(
    (await h.chains.action('history', { ...h.scope, pathId: input.pathId })).frames.at(-1).event,
    'stopped'
  )
  const repeated = await h.chains.action('stop', h.scope)
  assert.equal(repeated.revision, stopped.revision)
  await assert.rejects(
    h.chains.action('analyzePending', { ...h.scope, modelConfigId: 'model', maxPaths: 1 }),
    { code: 'RUN_RESUME_REQUIRED' }
  )
  await pause(50)
  assert.equal(h.model.requests.length, 1)
})

test('RUN-01 an external operation ignoring cancellation stays waiting and cannot commit its late result', async (t) => {
  const h = await createAgentHarness(t, 'continue')
  let release
  const gate = new Promise((r) => {
    release = r
  })
  let entered = false
  const delayed = new PathAnalysisService(h.repo, h.query, async (input) => {
    entered = true
    await gate
    return {
      verdict: 'unknown',
      summary: 'late result',
      steps: input.path.steps.map((s) => ({
        stepIndex: s.stepIndex,
        dangerous: null,
        reason: 'fixture',
        quotes: [input.evidence[s.stepIndex].text]
      }))
    }
  })
  h.chains.analysis = delayed
  const input = { ...h.scope, pathId: h.prepared.pathIds[0], modelConfigId: 'model' }
  delayed.start(input.projectId, input.runId, input.pathId, 'model')
  try {
    await until(() => entered)
    assert.equal(delayed.stop(input.projectId, input.runId).state, 'waiting_external')
    await pause(30)
    assert.equal(delayed.recovery(input.projectId, input.runId).state, 'waiting_external')
  } finally {
    release()
  }
  await delayed.waitForIdle()
  assert.equal(h.repo.detail(input).verdict, 'unknown')
  assert.ok(!h.repo.detail(input).summary.includes('late result'))
  assert.equal(delayed.recovery(input.projectId, input.runId).state, 'stopped')
})

test('RUN-02 damaged native artifact reconstructs from snapshot-verified tool receipts and records explicit fallback', async (t) => {
  const h = await boundary(t)
  const cp = h.db.get('SELECT * FROM recovery_checkpoints ORDER BY rowid DESC LIMIT 1')
  await writeFile(join(h.root, 'runtime', 'recovery', cp.file_name), 'broken half JSONL')
  const plan = await h.chains.action('recovery', h.scope)
  assert.equal(plan.mode, 'rebuild')
  assert.equal(plan.readSteps.length, 2)
  let diskReads = 0
  const original = h.query.methodContext.bind(h.query)
  h.query.methodContext = async (...args) => {
    diskReads++
    return original(...args)
  }
  await h.chains.action('resume', {
    ...h.scope,
    expectedRecoveryKey: plan.recoveryKey,
    maxPaths: 1
  })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail(h.input).status, 'unresolved')
  assert.equal(
    h.db.get('SELECT state FROM path_recovery WHERE path_id=?', h.input.pathId).state,
    'completed'
  )
  assert.equal(diskReads, 0)
  assert.equal((await h.chains.action('recovery', h.scope)).lastRecovery.mode, 'rebuild')
})

test('RUN-02 original model revision, snapshot bytes, budgets and recovery plan are enforced before another provider request', async (t) => {
  const h = await boundary(t)
  const requests = h.model.requests.length
  h.db.run("UPDATE model_configs SET revision=revision+1 WHERE id='model'")
  const blocked = await h.chains.action('recovery', h.scope)
  assert.equal(blocked.mode, 'blocked')
  assert.equal(blocked.canResume, false)
  await assert.rejects(
    h.chains.action('resume', {
      ...h.scope,
      expectedRecoveryKey: blocked.recoveryKey,
      maxPaths: 1
    }),
    { code: 'RUN_RECOVERY_BLOCKED' }
  )
  assert.equal(h.model.requests.length, requests)
  const budget = await boundary(t, { maxRounds: 1 })
  assert.equal(budget.plan.mode, 'blocked')
  assert.equal(budget.plan.canResume, false)
  assert.ok(budget.plan.reasons.some((s) => s.includes('预算')))
})

test('RUN fixed authenticated endpoints and main DTO reject forged scope, extra paths and invalid recovery fields', async (t) => {
  const h = await boundary(t)
  const server = await startHttpServer('fixture-run-token', {
    chainAction: (a, v, s) => h.chains.action(a, v, s)
  })
  t.after(() => server.close())
  assert.equal(
    (await fetch(`http://127.0.0.1:${server.port}/chains/recovery`, { method: 'POST' })).status,
    401
  )
  const response = await auditRequest(server.port, 'fixture-run-token', 'recovery', h.scope)
  assert.equal(response.ok, true)
  assert.equal(response.data.mode, 'native')
  assert.throws(() =>
    runControlInput('resume', {
      ...h.scope,
      expectedRecoveryKey: h.plan.recoveryKey,
      maxPaths: 1,
      sessionFile: 'C:\\arbitrary.jsonl'
    })
  )
  assert.throws(() =>
    runControlInput('resume', { ...h.scope, expectedRecoveryKey: 'fake', maxPaths: 1 })
  )
  assert.equal(isRunRecoveryView({ ...h.plan, sessionFile: 'private' }), false)
  assert.equal(
    (
      await auditRequest(server.port, 'fixture-run-token', 'stop', {
        ...h.scope,
        runId: 'another-run'
      })
    ).ok,
    false
  )
})

function worker(t, h, options) {
  const child = fork(join(import.meta.dirname, 'run-recovery-worker.mjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON']
  })
  const messages = [],
    errors = []
  child.on('message', (m) => messages.push(m))
  child.stderr.on('data', (b) => errors.push(String(b)))
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(Error('worker timeout ' + JSON.stringify(messages) + errors.join('')))
    }, 25000)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, messages, pid: child.pid })
    })
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
  })
  child.send({ root: h.root, scope: h.scope, pathId: h.prepared.pathIds[0], ...options })
  return { child, messages, done }
}

test('RUN-02 different-PID forced termination after safe Pi checkpoint resumes actual native context and never reexecutes committed paths', async (t) => {
  const h = await createAgentHarness(t, 'continue')
  const crashed = await worker(t, h, { killAt: 'checkpoint' }).done
  assert.notEqual(crashed.code, 0)
  assert.ok(h.db.get('SELECT checkpoint_id FROM recovery_checkpoints'))
  const before = h.model.requests.length
  const resumed = await worker(t, h, { action: 'resume' }).done
  assert.equal(resumed.code, 0, JSON.stringify(resumed.messages))
  assert.notEqual(resumed.pid, crashed.pid)
  const plan = resumed.messages.find((m) => m.type === 'plan').plan
  assert.equal(plan.mode, 'native')
  assert.equal(plan.state, 'interrupted')
  assert.equal(plan.requestsUsed, before)
  assert.equal(h.db.get("SELECT count(*) AS n FROM path_recovery WHERE state='completed'").n, 2)
  assert.equal(
    h.db.get('SELECT attempt FROM path_attempts WHERE path_id=?', h.prepared.pathIds[0]).attempt,
    2
  )
  assert.equal(
    h.db.get('SELECT attempt FROM path_attempts WHERE path_id=?', h.prepared.pathIds[1]).attempt,
    1
  )
  assert.equal(h.model.requests[before].messages.filter((m) => m.role === 'tool').length, 2)
  const completedRun = h.repo.scans.state(h.scope.projectId, h.scope.runId)
  assert.equal((await h.chains.action('stop', h.scope)).state, 'completed')
  assert.deepEqual(h.repo.scans.state(h.scope.projectId, h.scope.runId), completedRun)
})

test('RUN-02 crash after committed path but before delivery resumes the next pending path and replays original terminal without duplicate counts', async (t) => {
  const h = await createAgentHarness(t, 'continue')
  const crashed = await worker(t, h, { killAt: 'result-commit' }).done
  assert.notEqual(crashed.code, 0)
  const first = structuredClone(h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[0] }))
  const resumed = await worker(t, h, { action: 'resume' }).done
  assert.equal(resumed.code, 0, JSON.stringify(resumed.messages))
  assert.equal(resumed.messages.find((m) => m.type === 'plan').plan.committedPaths, 1)
  assert.deepEqual(h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[0] }), first)
  assert.equal(
    h.db.get('SELECT attempt FROM path_attempts WHERE path_id=?', h.prepared.pathIds[0]).attempt,
    1
  )
  assert.equal(h.db.get("SELECT count(*) AS n FROM path_recovery WHERE state='completed'").n, 2)
  const history = await h.chains.action('history', { ...h.scope, pathId: h.prepared.pathIds[0] })
  assert.equal(history.frames.at(-1).event, 'completed')
})

test('RUN-02 interrupted tool and orphan published file each rebuild using verified receipts with no invented tool success', async (t) => {
  for (const killAt of ['tool-receipt', 'published-file']) {
    const h = await createAgentHarness(t, 'continue')
    const crashed = await worker(t, h, { killAt }).done
    assert.notEqual(crashed.code, 0)
    assert.equal(h.db.get('SELECT count(*) AS n FROM recovery_checkpoints').n, 0)
    const resumed = await worker(t, h, { action: 'resume' }).done
    assert.equal(resumed.code, 0, killAt + JSON.stringify(resumed.messages))
    assert.equal(resumed.messages.find((m) => m.type === 'plan').plan.mode, 'rebuild')
    const data = JSON.parse(
      h.db.get('SELECT receipt_json FROM path_recovery WHERE path_id=?', h.prepared.pathIds[0])
        .receipt_json
    )
    assert.equal(data.mode, 'rebuild')
    assert.ok(
      h.repo
        .detail({ ...h.scope, pathId: h.prepared.pathIds[0] })
        .steps.every((s) => s.evidence.length)
    )
  }
})

test('RUN-02 actual in-flight model request crash preserves uncertain usage and restarts only uncommitted work', async (t) => {
  const h = await createAgentHarness(t, 'hold')
  const first = worker(t, h, {})
  await until(() => h.model.requests.length === 1)
  first.child.kill('SIGKILL')
  await first.done
  h.model.setMode('continue')
  const resumed = await worker(t, h, { action: 'resume' }).done
  assert.equal(resumed.code, 0, JSON.stringify(resumed.messages))
  const plan = resumed.messages.find((m) => m.type === 'plan').plan
  assert.equal(plan.mode, 'restart')
  assert.equal(plan.uncertainRequests, 1)
  assert.equal(plan.requestsUsed, 1)
  assert.equal(h.db.get("SELECT count(*) AS n FROM recovery_requests WHERE state='uncertain'").n, 1)
})

test('RUN-02 claim and recovery association commit atomically so a crash before the first model request remains recoverable', async (t) => {
  const h = await createAgentHarness(t, 'continue')
  const crashed = await worker(t, h, { killAt: 'claim' }).done
  assert.notEqual(crashed.code, 0)
  assert.equal(h.model.requests.length, 0)
  assert.equal(
    h.db.get('SELECT state FROM path_recovery WHERE path_id=?', h.prepared.pathIds[0]).state,
    'running'
  )
  const resumed = await worker(t, h, { action: 'resume', maxPaths: 1 }).done
  assert.equal(resumed.code, 0, JSON.stringify(resumed.messages))
  const plan = resumed.messages.find((m) => m.type === 'plan').plan
  assert.equal(plan.mode, 'restart')
  assert.equal(plan.requestsUsed, 0)
  assert.equal(plan.canResume, true)
})

test('RUN-02 a validated finish checkpoint commits after restart with zero repeated model requests', async (t) => {
  const h = await createAgentHarness(t, 'continue')
  const crashed = await worker(t, h, { killAt: 'finish-checkpoint' }).done
  assert.notEqual(crashed.code, 0)
  const before = h.model.requests.length
  const resumed = await worker(t, h, { action: 'resume', maxPaths: 1 }).done
  assert.equal(resumed.code, 0, JSON.stringify(resumed.messages))
  assert.equal(h.model.requests.length, before)
  assert.equal(
    h.db.get('SELECT state FROM path_recovery WHERE path_id=?', h.prepared.pathIds[0]).state,
    'completed'
  )
  assert.equal(h.repo.scans.statistics(h.scope.projectId, h.scope.runId).paths, 2)
})

test('RUN-01 stopped stage HTML/JSON retain recovery origin and uncertain request usage without model calls or secret material', async (t) => {
  const h = await createAgentHarness(t, 'hold')
  const input = { ...h.scope, pathId: h.prepared.pathIds[0], modelConfigId: 'model' }
  await h.chains.action('analyze', input)
  await until(() => h.model.requests.length === 1)
  await h.chains.action('stop', h.scope)
  await h.chains.analysis.waitForIdle()
  const reports = new ReportService(h.db, join(h.root, 'runtime'))
  t.after(() => reports.close())
  const filter = { verdict: 'all', pathStatus: 'all', reviewStatus: 'all' }
  const preview = await reports.action('preview', { ...h.scope, filter })
  const json = await reports.action('export', {
    ...h.scope,
    filter,
    format: 'json',
    expectedSnapshotKey: preview.snapshotKey
  })
  const html = await reports.action('generate', h.scope)
  assert.equal(json.status, 'ready')
  assert.equal(html.status, 'ready')
  const document = JSON.parse(await readFile(json.filePath, 'utf8')),
    text = await readFile(html.filePath, 'utf8')
  assert.equal(document.recovery.controlState, 'stopped')
  assert.equal(document.recovery.uncertainRequests, 1)
  assert.equal(document.run.errorCode, 'RUN_USER_STOP')
  assert.equal(document.stageReport, true)
  assert.ok(text.includes('恢复来源与用量边界'))
  assert.ok(!text.includes('local-fixture-key'))
  assert.equal(h.model.requests.length, 1)
})

test('RUN-02 v11 migration history remains unchanged and new checkpoint/tool receipts cannot be rewritten', async (t) => {
  const h = await boundary(t),
    db = new LocalDatabase(join(h.root, 'old-v11'))
  migrate(db, migrations.slice(0, 11))
  const history = db.all('SELECT * FROM schema_migrations ORDER BY version')
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 12)
  assert.deepEqual(
    db.all('SELECT * FROM schema_migrations WHERE version<=11 ORDER BY version'),
    history
  )
  db.close()
  assert.throws(() => h.db.exec("UPDATE recovery_checkpoints SET host_json='{}'"), {
    code: 'DB_QUERY_FAILED'
  })
  assert.throws(() => h.db.exec('DELETE FROM recovery_tools'), { code: 'DB_QUERY_FAILED' })
})
