// Local decoding only: no credential access and no provider requests.
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { loadManifest, digest } from '../qa/harness.mjs'
import { decodeCards } from '../qa/reference-decoder.mjs'
const root = resolve(process.argv[2]),
  receipt = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
const manifest = await loadManifest(),
  db = new DatabaseSync(join(root, 'runtime/storage/audit.sqlite3'), { readOnly: true })
try {
  const materials = receipt.materials.map((item) => {
    const known = manifest.cases.find((c) => c.id === item.id)
    const row = db
      .prepare(
        'SELECT f.content FROM run_snapshots r JOIN snapshot_files f ON f.snapshot_id=r.snapshot_id WHERE r.project_id=? AND r.run_id=? AND f.file_path=?'
      )
      .get(item.scope.projectId, item.scope.runId, known.fileName)
    const source = Buffer.from(row.content).toString('utf8')
    assert.equal(digest(source), item.sourceSha256)
    assert.equal(item.sourceSha256, known.sha256)
    return { ...item, source, expected: known.expected }
  })
  const trials = []
  for (const trial of receipt.trials) {
    const raw = await readFile(join(root, `visible-response-${trial.trial}.txt`), 'utf8')
    const results = decodeCards(raw, materials).map((answer) => ({
      ...answer,
      expected: materials.find((m) => m.id === answer.caseId).expected,
      correct:
        answer.valid && answer.verdict === materials.find((m) => m.id === answer.caseId).expected
    }))
    trials.push({
      trial: trial.trial,
      originalUsage: trial.usage,
      correct: results.filter((r) => r.correct).length,
      results
    })
  }
  const result = {
    ok: trials.length === 3 && trials.every((t) => t.correct === 18),
    model: receipt.model,
    corpusVersion: manifest.version,
    protocol: 'qa-evidence-cards/2.1; body or same-case ID alias, cross-case IDs forbidden',
    method:
      'redecoded stored actual provider responses against hash-verified SQLite source; no new model requests, no labels changed',
    tokenBudget: receipt.tokenBudget,
    sharedReportedTokens: receipt.reportedTokens,
    sharedRequests: receipt.sharedTotalRequests,
    trials
  }
  await writeFile(join(root, 'validated-result.json'), JSON.stringify(result, null, 2))
  console.log(
    JSON.stringify({
      ok: result.ok,
      correct: trials.map((t) => t.correct),
      sharedReportedTokens: result.sharedReportedTokens,
      replayModelRequests: 0
    })
  )
} finally {
  db.close()
}
