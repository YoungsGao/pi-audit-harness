import {
  mkdirSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  openSync,
  closeSync,
  unlinkSync
} from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { EvaluationService } from '../src/service/evaluation/service.ts'
import { WindowsCredentialStore } from '../src/service/storage/credential-store.ts'
import { evaluationMetrics } from '../src/shared/evaluation.ts'

const arg = (key, fallback) =>
  process.argv.includes(key) ? process.argv[process.argv.indexOf(key) + 1] : fallback
const live = process.argv.includes('--live')
const root = resolve(
  import.meta.dirname,
  '../../.local/investigation-eval',
  live ? 'live' : 'engineering'
)
mkdirSync(root, { recursive: true })
const lockFile = join(root, 'run.lock'),
  lock = openSync(lockFile, 'wx')
let service
try {
  let config, key
  if (live) {
    const db = new DatabaseSync(
      join(process.env.APPDATA, 'desktop/runtime/storage/audit.sqlite3'),
      { readOnly: true }
    )
    try {
      const row = db
        .prepare(
          'SELECT id,name,base_url,model_id,revision,secret_ref,api FROM model_configs WHERE id=?'
        )
        .get(arg('--config-id', '6d58b649-93c6-4447-a922-fbbbb0db4ca7'))
      if (
        !row ||
        row.model_id !== 'deepseek-flash' ||
        new URL(row.base_url).origin !== 'https://api.deepseek.com'
      )
        throw Error(
          'This paid lab is limited to the explicitly authorized saved DeepSeek-Flash configuration'
        )
      config = {
        id: row.id,
        name: row.name,
        baseUrl: row.base_url,
        modelId: row.model_id,
        revision: row.revision,
        secretRef: row.secret_ref,
        api: row.api
      }
    } finally {
      db.close()
    }
    key = await new WindowsCredentialStore().read(config.secretRef)
    if (!key) throw Error('Saved model credential missing')
  }
  const ports = { getConfig: async () => config, readSecret: async () => key }
  service = new EvaluationService(root, ports)
  const folder = join(root, 'evaluations')
  let used = 0
  for (const id of readdirSync(folder)) {
    if (!/^[a-f0-9-]{36}$/.test(id) || !existsSync(join(folder, id, 'result.json'))) continue
    const prior = JSON.parse(readFileSync(join(folder, id, 'result.json'), 'utf8'))
    used += prior.reportedUsage + prior.uncertainUsage + prior.reserved
  }
  const budget = Math.min(Number(arg('--token-budget', '50000')), 500000 - used)
  if (live && budget < 1000)
    throw Error('The newly authorized 500000-token shared budget is exhausted')
  const selected = arg('--cases', 'jdbc-concat,jdbc-bound,external-policy')
  const catalog = await service.action('catalog', {})
  const job = await service.action('start', {
    mode: live ? 'live' : 'engineering',
    caseIds: selected === 'all' ? catalog.cases.map((c) => c.id) : selected.split(','),
    trials: Number(arg('--trials', '1')),
    tokenBudget: budget,
    allowPaid: live,
    modelConfigId: config?.id,
    modelRevision: config?.revision
  })
  const stop = () => {
    void service.action('stop', { id: job.id })
  }
  process.once('SIGINT', stop)
  let result,
    previous = ''
  do {
    await new Promise((r) => setTimeout(r, 1000))
    result = await service.action('detail', { id: job.id })
    if (result.current !== previous) {
      console.error(result.current || result.state)
      previous = result.current
    }
    if (live)
      writeFileSync(
        join(root, 'budget-summary.json'),
        JSON.stringify(
          {
            limit: 500000,
            previousUsed: used,
            currentReported: result.reportedUsage,
            currentUncertain: result.uncertainUsage,
            currentReserved: result.reserved,
            jobId: result.id
          },
          null,
          2
        )
      )
  } while (result.state === 'running')
  process.removeListener('SIGINT', stop)
  const summary = {
    id: result.id,
    mode: result.mode,
    state: result.state,
    errorCode: result.errorCode,
    resultFile: join(folder, result.id, 'result.json'),
    usage: result.reportedUsage,
    uncertain: result.uncertainUsage,
    sharedUsed: used + result.reportedUsage + result.uncertainUsage,
    comparisons: Object.fromEntries(
      ['steps', 'codegraph', 'full'].map((g) => [g, evaluationMetrics(result, g)])
    )
  }
  console.log(
    JSON.stringify(summary, null, 2).replace(
      /[\u0080-\uffff]/g,
      (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')
    )
  )
  if (result.state === 'failed') process.exitCode = 1
} finally {
  await service?.close()
  closeSync(lock)
  unlinkSync(lockFile)
}
