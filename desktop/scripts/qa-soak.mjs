// QA-02 wall-clock soak. Uses real snapshot/query/SQLite/report services, never a paid provider.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { savedReportSnapshot, renderReportJson } from '../src/service/reports/snapshot.ts'
const index = process.argv.indexOf('--duration-ms')
const duration = index < 0 ? 3600000 : Number(process.argv[index + 1])
assert.ok(Number.isSafeInteger(duration) && duration >= 1000 && duration <= 86400000)
const base = resolve(import.meta.dirname, '../../.local/qa/soak')
await mkdir(base, { recursive: true })
const root = await mkdtemp(join(base, 'run-')),
  source = join(root, 'source'),
  dataRoot = join(root, 'runtime')
await mkdir(source)
for (let i = 0; i < 100; i++) {
  const name = 'Load' + String(i).padStart(3, '0')
  const lines = [
    'package qa.load;',
    'import java.sql.Statement;',
    `class ${name} {`,
    'Statement stmt;',
    `@GetMapping("/load/${i}")`,
    'String endpoint(String q) throws Exception {',
    'String value=q;',
    ...Array.from({ length: 489 }, () => 'value = q;'),
    'stmt.executeQuery("SELECT "+value);',
    'return value;',
    '}',
    '}'
  ]
  assert.equal(lines.length, 500)
  await writeFile(join(source, name + '.java'), lines.join('\n'))
}
await writeFile(
  join(root, 'manifest.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      durationMs: duration,
      physicalLines: 50000,
      files: 100,
      expectedCandidates: 100,
      sourceKind: 'synthetic repeated assignments; not a production throughput benchmark'
    },
    null,
    2
  )
)
console.log('QA_SOAK_ROOT=' + root)
const db = openStorage(dataRoot),
  sources = new SourceRepository(db),
  query = new CodeQueryService(sources, { dataRoot })
const repo = new CallChainRepository(db),
  chains = new CallChainService(repo, query)
const started = performance.now(),
  startedAt = new Date().toISOString()
let cycles = 0,
  peakRss = process.memoryUsage().rss,
  maxQueryMs = 0,
  maxLoopDelayMs = 0
const failures = []
try {
  const project = await importLocal(sources, { projectName: 'QA02 50k soak', path: source })
  const scanAt = performance.now()
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  const prepareMs = performance.now() - scanAt
  assert.equal(prepared.pathIds.length, 100, JSON.stringify(prepared.warnings))
  const scope = { projectId: project.projectId, runId: prepared.runId }
  while (performance.now() - started < duration) {
    const at = performance.now()
    const filePath = `Load${String(cycles % 100).padStart(3, '0')}.java`
    const symbols = await query.action('query', {
      ...scope,
      language: 'java',
      operation: 'symbols',
      filePath,
      fallback: false
    })
    assert.equal(symbols.backend, 'codegraph')
    assert.ok(symbols.items.length > 0)
    maxQueryMs = Math.max(maxQueryMs, performance.now() - at)
    assert.equal(repo.list({ ...scope, limit: 100 }).paths.length, 100)
    if (cycles % 10 === 0) {
      const report = JSON.parse(
        renderReportJson(savedReportSnapshot(db, scope.projectId, scope.runId), 'soak')
      )
      assert.equal(report.paths.length, 100)
      db.transaction((tx) =>
        tx.get('SELECT count(*) AS n FROM call_paths WHERE run_id=?', scope.runId)
      )
      await appendFile(
        join(root, 'samples.jsonl'),
        JSON.stringify({
          elapsedMs: performance.now() - started,
          cycle: cycles,
          rss: process.memoryUsage().rss,
          heapUsed: process.memoryUsage().heapUsed,
          queryMs: performance.now() - at
        }) + '\n'
      )
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss)
    cycles++
    const pauseAt = performance.now()
    await new Promise((r) =>
      setTimeout(r, Math.min(1000, Math.max(1, duration - (performance.now() - started))))
    )
    maxLoopDelayMs = Math.max(maxLoopDelayMs, performance.now() - pauseAt - 1000)
  }
  const elapsedMs = performance.now() - started
  const result = {
    ok: true,
    startedAt,
    finishedAt: new Date().toISOString(),
    elapsedMs,
    requiredMs: duration,
    oneHourComplete: elapsedMs >= 3600000,
    cycles,
    prepareMs,
    peakRss,
    maxQueryMs,
    maxLoopDelayMs,
    modelRequests: 0,
    scope,
    failures
  }
  await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} catch (error) {
  failures.push({ code: error.code ?? 'QA_SOAK_FAILED', message: error.message })
  await writeFile(
    join(root, 'result.json'),
    JSON.stringify({ ok: false, elapsedMs: performance.now() - started, cycles, failures }, null, 2)
  )
  throw error
} finally {
  await chains.close()
  await query.close()
  db.close()
}
