// Explicit opt-in paid calibration. Reads exactly one existing configuration; never writes its key/config.
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  qaRoot,
  openHarness,
  loadManifest,
  prepareCase,
  acceptanceRoot,
  writeResult
} from '../qa/harness.mjs'
import { WindowsCredentialStore } from '../src/service/storage/credential-store.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { createPiResources } from '../src/service/pi-resources.ts'
import { createManagedSession } from '../src/service/pi-session-factory.ts'
import { containsKnownCredential } from '../src/shared/redaction.ts'
const args = process.argv.slice(2)
assert.ok(args.includes('--live'), 'Paid evaluation requires explicit --live')
const arg = (key, fallback) => (args.includes(key) ? args[args.indexOf(key) + 1] : fallback)
const configId = arg('--config-id', '6d58b649-93c6-4447-a922-fbbbb0db4ca7')
const dbFile = resolve(
  arg('--config-db', join(process.env.APPDATA, 'desktop/runtime/storage/audit.sqlite3'))
)
const budget = Number(arg('--token-budget', '30000'))
const evidenceCards = args.includes('--evidence-cards')
const ledgerFile = resolve(arg('--budget-ledger', '../.local/qa/live-budget.json'))
let ledger
try {
  ledger = JSON.parse(await readFile(ledgerFile, 'utf8'))
} catch {
  ledger = { budget, spent: 0, requests: 0, priorMaxInput: 0, attempts: [] }
}
assert.equal(ledger.budget, budget, 'Shared budget cannot be silently changed')
assert.ok(Number.isSafeInteger(budget) && budget >= 1000 && budget <= 100000)
const original = new DatabaseSync(dbFile, { readOnly: true })
let row
try {
  row = original
    .prepare(
      'SELECT id,name,base_url,model_id,secret_ref,revision,api FROM model_configs WHERE id=?'
    )
    .get(configId)
} finally {
  original.close()
}
assert.ok(
  row && row.model_id === 'deepseek-flash' && row.secret_ref,
  'Pinned DeepSeek-Flash config not available'
)
const target = new URL(row.base_url)
assert.ok(
  target.protocol === 'https:' &&
    target.hostname === 'api.deepseek.com' &&
    !target.username &&
    !target.password &&
    !target.search &&
    !target.hash,
  'Configured target changed; refusing calibration'
)
const apiKey = await new WindowsCredentialStore().read(row.secret_ref)
assert.ok(apiKey, 'Selected system credential is unavailable')
const selected = {
  config: {
    id: row.id,
    name: row.name,
    revision: row.revision,
    modelId: row.model_id,
    baseUrl: row.base_url,
    api: row.api,
    secretRef: row.secret_ref
  },
  apiKey
}
const root = await qaRoot('reference-model'),
  h = await openHarness(root),
  runtime = new PiRuntime(join(root, 'pi'))
const manifest = await loadManifest(),
  materials = [],
  trials = []
let used = ledger.spent,
  requests = 0
const cleanIdentity = {
  configId,
  name: row.name,
  modelId: row.model_id,
  revision: row.revision,
  baseUrl: row.base_url
}
console.log('QA_REFERENCE_ROOT=' + root)
try {
  for (const item of manifest.cases) {
    const current = await prepareCase(h, item)
    const paths = current.prepared.pathIds.map((pathId) =>
      h.repo.detail({ ...current.scope, pathId })
    )
    const source = await readFile(join(acceptanceRoot, item.id, item.fileName), 'utf8')
    materials.push({
      id: item.id,
      source,
      sourceSha256: item.sha256,
      scope: current.scope,
      coverage: {
        externallyLocated: paths.some((p) => p.sourceRef?.startsWith('http-entry-candidate:')),
        truncated: paths.some((p) => p.truncated),
        graph: 'codegraph structural candidates, not Java type binding'
      }
    })
  }
  for (let trial = 1; trial <= 3; trial++) {
    const rotation = (trial - 1) * 5
    const ordered = [...materials.slice(rotation), ...materials.slice(0, rotation)]
    const batch = evidenceCards
      ? ordered.map(({ id, source, coverage }) => [
          id,
          source.split('\n')[6],
          coverage.externallyLocated ? 'http' : 'boundary',
          coverage.truncated
        ])
      : ordered.map(({ id, source, coverage }) => ({ id, source, coverage }))
    const prompt =
      (evidenceCards
        ? '静态审计，输入为[样例id,源码卡body,http或boundary,覆盖是否截断]。dangerous需外部来源和完整传播且无防护；safe需明确阻断。boundary、截断、调用目标歧义、未知外部策略/防护实现用unknown。参数数组不防shell注入，固定程序参数或闭合白名单可阻断。仅输出一个JSON对象：全部18个样例id为键，值为["dangerous|safe|unknown","body"]。body是已有原文证据卡编号，由宿主解析原文，不生成引用文字。不要Markdown或理由。\n'
        : '固定源码验收分类，不执行代码。逐项独立审查：dangerous需外部来源、传播与危险参数完整且无有效防护；safe需明确阻断；缺依赖/防护实现/类型目标/外部来源或coverage.truncated时保留unknown。仅返回JSON对象，键为全部18个case id，值为数组["dangerous|safe|unknown","源码逐字引用，最多32字符","理由最多12汉字"]。不要Markdown。\n') +
      JSON.stringify(batch)
    let session
    const observed = []
    const started = performance.now()
    await runtime
      .run(async (signal) => {
        const resources = await createPiResources(runtime.workDir, runtime.agentDir)
        session = await createManagedSession(runtime, selected, resources, [], signal, () => {}, {
          contextWindow: 32768,
          maxTokens: evidenceCards ? 700 : 1800
        })
        // The first pilot measured the identical corpus input; subsequent compact prompts are shorter.
        // Reserve uses that observed input high-water plus 512 overhead, and the full output cap.
        const reserve =
          (ledger.priorMaxInput ||
            Buffer.byteLength(prompt + session.agent.state.systemPrompt, 'utf8')) +
          (evidenceCards ? 700 : 1800) +
          512
        if (used + reserve > budget)
          throw Error('QA_TOKEN_BUDGET: next request worst-case allowance exceeds remaining budget')
        const send = session.agent.streamFunction
        session.agent.streamFunction = (model, context, options) => {
          if (
            requests >= 3 ||
            ledger.requests >= 9 ||
            model.id !== row.model_id ||
            model.baseUrl !== row.base_url
          )
            throw Error('QA_REQUEST_SCOPE')
          requests++
          ledger.requests++
          return send(model, context, options)
        }
        session.subscribe((event) => {
          if (event.type === 'message_end' && event.message.role === 'assistant')
            observed.push({
              usage: event.message.usage,
              stopReason: event.message.stopReason,
              model: event.message.model
            })
        })
        await session.prompt(prompt)
        const message = observed.at(-1)
        assert.ok(
          message && !['error', 'aborted'].includes(message.stopReason),
          'Reference model did not finish normally'
        )
        const usage = message.usage
        const total = Number(
          usage?.totalTokens ??
            Number(usage?.input ?? 0) +
              Number(usage?.output ?? 0) +
              Number(usage?.cacheRead ?? 0) +
              Number(usage?.cacheWrite ?? 0)
        )
        assert.ok(
          Number.isFinite(total) && total > 0,
          'Provider did not report token usage; stop further paid requests'
        )
        used += total
        ledger.spent = used
        ledger.priorMaxInput = Math.max(
          ledger.priorMaxInput,
          Number(usage.input ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0)
        )
        await writeFile(ledgerFile, JSON.stringify(ledger, null, 2))
        const raw = session.getLastAssistantText()?.trim() ?? ''
        assert.equal(containsKnownCredential(raw, [apiKey]), false, 'QA_SECRET_ECHO')
        await writeFile(join(root, `visible-response-${trial}.txt`), raw)
        let parsed
        try {
          parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''))
        } catch {
          parsed = null
        }
        const entries =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? Object.entries(parsed).map(([id, answer]) => ({
                id,
                verdict: answer?.[0],
                evidenceId: evidenceCards ? answer?.[1] : undefined,
                quote:
                  evidenceCards && answer?.[1] === 'body'
                    ? materials.find((m) => m.id === id)?.source.split('\n')[6]
                    : answer?.[1],
                reason: evidenceCards ? 'host-resolved source evidence card' : answer?.[2]
              }))
            : []
        const results = manifest.cases.map((item) => {
          const answers = entries.filter((answer) => answer.id === item.id),
            answer = answers[0]
          const source = materials.find((m) => m.id === item.id).source
          const schemaValid =
            answers.length === 1 &&
            ['safe', 'dangerous', 'unknown'].includes(answer?.verdict) &&
            typeof answer?.quote === 'string' &&
            typeof answer?.reason === 'string'
          const quoteValid = schemaValid && answer.quote.length > 0 && source.includes(answer.quote)
          return {
            caseId: item.id,
            expected: item.expected,
            observed: schemaValid ? answer.verdict : null,
            evidenceId: answer?.evidenceId,
            quote: schemaValid ? answer.quote : null,
            reason: schemaValid ? answer.reason : 'invalid/missing structured item',
            quoteValid,
            verdictCorrect: schemaValid && answer.verdict === item.expected,
            correct: quoteValid && answer.verdict === item.expected
          }
        })
        trials.push({
          trial,
          rotation,
          elapsedMs: performance.now() - started,
          usage,
          stopReason: message.stopReason,
          observedModel: message.model,
          outputItemCount: entries.length,
          correct: results.filter((r) => r.correct).length,
          unknownFalseSafe: results.filter((r) => r.expected === 'unknown' && r.observed === 'safe')
            .length,
          results
        })
      }, 120000)
      .finally(() => session?.dispose())
    await writeResult(root, 'result.json', {
      model: cleanIdentity,
      mode: 'three batch reference-model classification trials; distinct from per-path agent-loop acceptance',
      corpusVersion: manifest.version,
      tokenBudget: budget,
      reportedTokens: used,
      requests,
      materials: materials.map((m) =>
        Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'source'))
      ),
      trials
    })
    console.log(
      JSON.stringify({
        trial,
        correct: trials.at(-1).correct,
        cases: 18,
        reportedTokens: used,
        requests
      })
    )
  }
  const passed = trials.length === 3 && trials.every((t) => t.correct === 18)
  await writeResult(root, 'result.json', {
    ok: passed,
    model: cleanIdentity,
    mode: evidenceCards
      ? 'three real-provider evidence-card classification trials; host resolves frozen source, no expected labels sent'
      : 'three real-provider free-quote classification trials; no expected labels sent',
    corpusVersion: manifest.version,
    tokenBudget: budget,
    reportedTokens: used,
    requests,
    sharedTotalRequests: ledger.requests,
    materials: materials.map((m) =>
      Object.fromEntries(Object.entries(m).filter(([k]) => k !== 'source'))
    ),
    trials
  })
  console.log(
    JSON.stringify({
      completed: true,
      baselinePassed: passed,
      requests,
      reportedTokens: used,
      tokenBudget: budget
    })
  )
} catch (error) {
  const code =
    typeof error.code === 'string'
      ? error.code
      : String(error.message).startsWith('QA_')
        ? error.message
        : 'QA_REFERENCE_FAILED'
  await writeResult(root, 'result.json', {
    ok: false,
    model: cleanIdentity,
    tokenBudget: budget,
    reportedTokens: used,
    requests,
    trials,
    errorCode: code
  })
  console.error('QA real model stopped: ' + code)
  process.exitCode = 1
} finally {
  await h.close()
  await runtime.close()
}
