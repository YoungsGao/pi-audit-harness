// Explicit paid, end-to-end production-loop evaluation. Does not mutate the user's database.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, writeFile, open, unlink } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { openHarness, loadManifest, prepareCase, authorize } from '../qa/harness.mjs'
import { importLocal } from '../src/service/sources/local.ts'
import { WindowsCredentialStore } from '../src/service/storage/credential-store.ts'
import { ApiError } from '../src/shared/api-error.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { runAgentLoop } from '../src/service/chains/agent-loop.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { savedReportSnapshot, renderReportJson } from '../src/service/reports/snapshot.ts'

assert.ok(process.argv.includes('--live'), 'Real requests require --live')
const arg = (key, fallback) =>
  process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback
const base = resolve(import.meta.dirname, '../../.local/reliability/2026-11-10')
await mkdir(base, { recursive: true })
const lockFile = join(base, 'budget.lock'),
  lock = await open(lockFile, 'wx')
let h, runtime
const originalFetch = globalThis.fetch
try {
  const ledgerFile = join(base, 'budget.json')
  let ledger
  try {
    ledger = JSON.parse(await readFile(ledgerFile, 'utf8'))
  } catch {
    ledger = { budget: 1000000, spent: 0, reserved: 0, requests: 0, receipts: [] }
  }
  assert.equal(ledger.budget, 1000000)
  ledger.uncertainCharge ??= 0
  if (ledger.reserved && process.argv.includes('--settle-uncertain')) {
    ledger.uncertain ??= []
    ledger.uncertain.push({
      at: new Date().toISOString(),
      upperBound: ledger.reserved,
      reason: 'prior provider request returned no usage; full reserve conservatively charged'
    })
    ledger.uncertainCharge += ledger.reserved
    ledger.reserved = 0
    writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
  }
  assert.equal(
    ledger.reserved,
    0,
    'Prior usage is uncertain; inspect and conservatively settle the reserve before continuing'
  )
  const persist = () => writeFile(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
  const original = new DatabaseSync(
    join(process.env.APPDATA, 'desktop/runtime/storage/audit.sqlite3'),
    { readOnly: true }
  )
  const row = original
    .prepare(
      'SELECT id,name,base_url,model_id,revision,secret_ref,api FROM model_configs WHERE id=?'
    )
    .get('6d58b649-93c6-4447-a922-fbbbb0db4ca7')
  original.close()
  assert.ok(
    row &&
      row.model_id === 'deepseek-flash' &&
      new URL(row.base_url).hostname === 'api.deepseek.com' &&
      new URL(row.base_url).protocol === 'https:'
  )
  const key = await new WindowsCredentialStore().read(row.secret_ref)
  assert.ok(key)
  const config = {
    id: row.id,
    name: row.name,
    modelId: row.model_id,
    baseUrl: row.base_url,
    revision: row.revision,
    secretRef: row.secret_ref,
    api: row.api
  }
  const root = await mkdtemp(join(base, arg('--phase', 'production') + '-'))
  let wireRequests = 0
  globalThis.fetch = (url, options) => {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.href : url.url
    if (new URL(target).hostname === 'api.deepseek.com' && typeof options?.body === 'string') {
      const body = JSON.parse(options.body)
      writeFileSync(
        join(root, 'request-' + ++wireRequests + '.metadata.json'),
        JSON.stringify(
          {
            model: body.model,
            response_format: body.response_format,
            temperature: body.temperature,
            max_tokens: body.max_tokens,
            max_completion_tokens: body.max_completion_tokens,
            thinking: body.thinking
          },
          null,
          2
        ) + '\n'
      )
    }
    return originalFetch(url, options)
  }
  h = await openHarness(root)
  runtime = new PiRuntime(join(root, 'pi'))
  h.db.run(
    'INSERT INTO model_configs(id,name,base_url,model_id,secret_ref,revision,api) VALUES(?,?,?,?,?,?,?)',
    config.id,
    config.name,
    config.baseUrl,
    config.modelId,
    config.secretRef,
    config.revision,
    config.api
  )
  const ports = {
    getConfig: async (id) => (id === config.id ? config : undefined),
    readSecret: async (ref) => (ref === config.secretRef ? key : undefined)
  }
  h.chains.analysis = new PathAnalysisService(
    h.repo,
    h.query,
    (input, signal) =>
      runAgentLoop(
        runtime,
        ports,
        {
          ...input,
          observeDecision: (text, stopReason) => {
            writeFileSync(
              join(root, input.pathId + '-' + ledger.requests + '.visible.json'),
              JSON.stringify({ stopReason, text }, null, 2) + '\n'
            )
          },
          beforeModelRequest: ({ inputBytes, maxOutputTokens }) => {
            const reserve = inputBytes + maxOutputTokens + 8192
            if (ledger.spent + ledger.uncertainCharge + ledger.reserved + reserve > ledger.budget)
              throw new ApiError('QA_TOKEN_BUDGET', '真实测试共享预算不足，未发送新请求', 409)
            ledger.reserved += reserve
            ledger.requests++
            // Reserve synchronously before entering the transport, including interrupted/uncertain requests.
            writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
          },
          recordEvent: (event) => {
            if (event.status === 'request_retry' && ledger.reserved) {
              ledger.uncertain ??= []
              ledger.uncertain.push({
                at: new Date().toISOString(),
                upperBound: ledger.reserved,
                root,
                reason: 'bounded transient retry; prior usage unknown'
              })
              ledger.uncertainCharge += ledger.reserved
              ledger.reserved = 0
              writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
            }
            if (event.status === 'model_usage') {
              const meter = event.payload.meter
              const used = Number(
                meter.total ?? meter.input + meter.output + meter.cacheRead + meter.cacheWrite
              )
              assert.ok(Number.isSafeInteger(used) && used >= 0)
              if (used === 0 && ledger.reserved) {
                ledger.uncertain ??= []
                ledger.uncertain.push({
                  at: new Date().toISOString(),
                  root,
                  upperBound: ledger.reserved,
                  reason:
                    'nonempty provider response without usable usage; full reserve charged conservatively'
                })
                ledger.uncertainCharge += ledger.reserved
              }
              ledger.spent += used
              ledger.reserved = 0
              ledger.receipts.push({ at: new Date().toISOString(), root, used, meter })
              writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2) + '\n')
              assert.ok(ledger.spent <= ledger.budget)
            }
            input.recordEvent?.(event)
          }
        },
        signal
      ),
    true
  )
  const manifest = await loadManifest(),
    selected = arg('--case', 'smoke'),
    suppliedSource = arg('--source', '')
  const cases =
    selected === 'smoke'
      ? [
          {
            id: suppliedSource ? 'user-repro' : 'smoke',
            expected: suppliedSource ? arg('--reference', 'unknown') : 'dangerous'
          }
        ]
      : manifest.cases.filter((c) => selected === 'all' || selected.split(',').includes(c.id))
  assert.ok(cases.length)
  const rows = [],
    trials = Number(arg('--trials', '1'))
  assert.ok(Number.isInteger(trials) && trials >= 1 && trials <= 3)
  console.log('LIVE_AGENT_ROOT=' + root)
  for (let trial = 1; trial <= trials; trial++)
    for (const item of cases) {
      let current
      if (item.id === 'smoke' || item.id === 'user-repro') {
        const project = await importLocal(h.sources, {
          projectName: 'live full-loop regression',
          path: suppliedSource
            ? resolve(suppliedSource)
            : resolve(import.meta.dirname, '../tests/fixtures/scan-java'),
          duplicate: 'new'
        })
        const prepared = await h.chains.action('prepare', { projectId: project.projectId })
        current = { prepared, scope: { projectId: project.projectId, runId: prepared.runId } }
      } else current = await prepareCase(h, item)
      await authorize(h, current.scope, config.id)
      const candidates =
        arg('--path-kind', 'all') === 'truncated'
          ? current.prepared.pathIds.filter(
              (id) => h.repo.detail({ ...current.scope, pathId: id }).truncated
            )
          : current.prepared.pathIds
      assert.ok(candidates.length, 'No path matches the declared structural selection')
      const pathIds = process.argv.includes('--all-paths') ? candidates : candidates.slice(0, 1)
      for (const pathId of pathIds) {
        const start = performance.now(),
          before = ledger.spent,
          beforeRequests = ledger.requests
        await h.chains.action('analyze', { ...current.scope, pathId, modelConfigId: config.id })
        await h.chains.analysis.waitForIdle()
        const detail = h.repo.detail({ ...current.scope, pathId }),
          attempt = h.db.get('SELECT phase,error_code FROM path_attempts WHERE path_id=?', pathId)
        const events = h.db.all(
          'SELECT type,status,summary,payload_json FROM analysis_events WHERE chain_id=? ORDER BY seq',
          pathId
        )
        const json = JSON.parse(
          renderReportJson(
            savedReportSnapshot(h.db, current.scope.projectId, current.scope.runId),
            'live-quality'
          )
        )
        assert.equal(json.paths.find((p) => p.pathId === pathId).verdict, detail.verdict)
        const record = {
          caseId: item.id,
          trial,
          ...current.scope,
          pathId,
          steps: detail.steps.length,
          truncated: detail.truncated,
          truncationReason: detail.truncationReason,
          sourceRef: detail.sourceRef,
          discoveredPaths: current.prepared.pathIds.length,
          selectedPathKind: arg('--path-kind', 'all'),
          status: detail.status,
          verdict: detail.verdict,
          reference: item.expected,
          phase: attempt.phase,
          errorCode: attempt.error_code,
          evidenceSteps: detail.steps.filter((s) => s.evidence.length > 0).length,
          validation: events
            .filter((e) => e.status.startsWith('validation_'))
            .map((e) => ({
              status: e.status,
              summary: e.summary,
              payload: JSON.parse(e.payload_json)
            })),
          elapsedMs: performance.now() - start,
          tokens: ledger.spent - before,
          requests: ledger.requests - beforeRequests,
          graphBackend: json.queryGraph.backend
        }
        rows.push(record)
        await writeFile(
          join(root, 'result.json'),
          JSON.stringify(
            {
              model: { name: config.name, modelId: config.modelId, revision: config.revision },
              phase: arg('--phase', 'production'),
              rows,
              sharedTokens: ledger.spent,
              sharedRequests: ledger.requests,
              sharedBudget: ledger.budget
            },
            null,
            2
          ) + '\n'
        )
        console.log(
          JSON.stringify({
            caseId: item.id,
            trial,
            status: record.status,
            verdict: record.verdict,
            errorCode: record.errorCode,
            tokens: record.tokens,
            sharedTokens: ledger.spent
          })
        )
        if (ledger.reserved) throw new Error('Request usage uncertain; paid tests stopped')
      }
    }
  await persist()
  if (process.argv.includes('--require-complete'))
    assert.ok(
      rows.every((r) => r.phase === 'completed'),
      'Some production loops did not finish; inspect result.json'
    )
} finally {
  globalThis.fetch = originalFetch
  await h?.close()
  await runtime?.close()
  await lock.close()
  await unlink(lockFile)
}
