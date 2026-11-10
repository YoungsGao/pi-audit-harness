// Separates discovery/graph/evidence regression from measured model quality.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { join } from 'node:path'
import {
  qaRoot,
  openHarness,
  loadManifest,
  prepareCase,
  authorize,
  writeResult
} from '../qa/harness.mjs'
import { createAgentModelFixture } from '../tests/agent-model-fixture.mjs'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { runAgentLoop } from '../src/service/chains/agent-loop.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { builtinRules } from '../src/service/rules/builtin.ts'
import { savedReportSnapshot, renderReportJson } from '../src/service/reports/snapshot.ts'
import { renderSavedReport } from '../src/service/reports/html.ts'
import { writeFile } from 'node:fs/promises'
const manifest = await loadManifest(),
  root = await qaRoot('acceptance'),
  h = await openHarness(root)
const model = await createAgentModelFixture({ mode: 'finish' }),
  runtime = new PiRuntime(join(root, 'pi'))
const config = {
  id: 'qa-offline-reference',
  name: 'QA deterministic protocol oracle',
  revision: 1,
  modelId: 'fixture',
  api: 'openai-completions',
  secretRef: 'qa-fake-ref',
  baseUrl: model.baseUrl
}
h.db.run(
  'INSERT INTO model_configs(id,name,base_url,model_id,secret_ref,revision) VALUES(?,?,?,?,?,?)',
  config.id,
  config.name,
  config.baseUrl,
  config.modelId,
  config.secretRef,
  config.revision
)
const ports = { getConfig: async () => config, readSecret: async () => 'local-fixture-key' }
h.chains.analysis = new PathAnalysisService(
  h.repo,
  h.query,
  (input, signal) => runAgentLoop(runtime, ports, input, signal),
  true
)
const rows = []
console.log('QA_ACCEPTANCE_ROOT=' + root)
try {
  for (const item of manifest.cases) {
    for (let trial = 1; trial <= 3; trial++) {
      const started = performance.now(),
        current = await prepareCase(h, item)
      const details = current.prepared.pathIds.map((pathId) =>
        h.repo.detail({ ...current.scope, pathId })
      )
      assert.ok(current.prepared.candidateCount >= 1, item.id + ' missed declared sink')
      assert.ok(details.length > 0, item.id + ' no path')
      const binding = h.sources.graphs.get(current.scope.projectId, current.scope.runId)
      assert.equal(binding.backend, 'codegraph')
      for (const detail of details)
        for (const step of detail.steps) {
          const source = h.sources.snapshots.read(
            current.scope.projectId,
            current.scope.runId,
            step.edge.filePath
          )
          assert.ok(
            source.split('\n')[step.edge.callLine - 1].trim(),
            'edge does not locate source'
          )
        }
      // Intentional oracle response: tests validation/persistence, never counted as LLM accuracy.
      model.setMode(item.expected === 'unknown' ? 'finish' : item.expected)
      await authorize(h, current.scope, config.id)
      const pathId = current.prepared.pathIds[0]
      await h.chains.action('analyze', { ...current.scope, pathId, modelConfigId: config.id })
      await h.chains.analysis.waitForIdle()
      const detail = h.repo.detail({ ...current.scope, pathId })
      const expectedHost =
        details[0].truncated && item.expected === 'safe' ? 'unknown' : item.expected
      assert.equal(detail.verdict, expectedHost, item.id + ' oracle host result: ' + detail.summary)
      assert.ok(
        detail.steps.every((step) => step.evidence.length > 0),
        item.id + ' unlocatable saved evidence'
      )
      const snapshot = savedReportSnapshot(h.db, current.scope.projectId, current.scope.runId)
      const json = JSON.parse(renderReportJson(snapshot, 'qa-' + item.id + '-' + trial))
      assert.equal(json.paths.find((p) => p.pathId === pathId).verdict, detail.verdict)
      rows.push({
        caseId: item.id,
        trial,
        expectedReference: item.expected,
        hostVerdict: detail.verdict,
        candidateCount: current.prepared.candidateCount,
        pathCount: details.length,
        truncated: details.some((p) => p.truncated),
        graphBackend: binding.backend,
        scope: current.scope,
        pathId,
        elapsedMs: performance.now() - started,
        protocolValidation: true,
        modelQualityMeasured: false
      })
      if (trial === 1 && item.id === 'sql-positive-1') {
        await writeFile(join(root, 'example-report.json'), renderReportJson(snapshot, 'qa-example'))
        await writeFile(join(root, 'example-report.html'), renderSavedReport(snapshot))
      }
    }
  }
  await writeResult(root, 'result.json', {
    ok: true,
    corpusVersion: manifest.version,
    rulesVersion: builtinRules.version,
    cases: 18,
    trials: 3,
    executions: rows.length,
    reference: 'deterministic local protocol oracle; not LLM accuracy',
    modelRequests: model.requests.length,
    rows
  })
  console.log(
    'PASS QA-01 offline: ' +
      rows.length +
      ' fixed-snapshot executions, sink/graph/evidence/report checks; no paid model.'
  )
} catch (error) {
  await writeResult(root, 'result.json', {
    ok: false,
    rows,
    error: { code: error.code, message: error.message }
  })
  throw error
} finally {
  await h.close()
  await runtime.close()
  await model.close()
}
