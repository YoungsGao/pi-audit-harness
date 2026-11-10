// Fixed upstream excerpt, unmodified. It is kept in .local, not redistributed as application source.
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { qaRoot, openHarness, digest, writeResult, authorize } from '../qa/harness.mjs'
import { importLocal } from '../src/service/sources/local.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { runAgentLoop } from '../src/service/chains/agent-loop.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { createAgentModelFixture } from '../tests/agent-model-fixture.mjs'
import { ReportService } from '../src/service/reports/service.ts'
const commit = '4e98f1cbbf896fdd06edcc9930515ebe0ade7c69'
const upstreamPath =
  'src/main/java/org/owasp/webgoat/lessons/sqlinjection/introduction/SqlInjectionLesson5.java'
const url = `https://raw.githubusercontent.com/WebGoat/WebGoat/${commit}/${upstreamPath}`
const expectedHash = '455007672e023cd419069b2dcf3dee21c1f4c222ea58e3487073b1657d1a3b15'
const root = await qaRoot('real-project'),
  source = join(root, 'source')
await mkdir(source)
const response = await fetch(url)
assert.ok(response.ok, 'Cannot obtain pinned upstream file')
const bytes = Buffer.from(await response.arrayBuffer())
assert.equal(digest(bytes), expectedHash, 'Upstream bytes changed')
await writeFile(join(source, 'SqlInjectionLesson5.java'), bytes)
const h = await openHarness(root),
  model = await createAgentModelFixture({ mode: 'finish' }),
  runtime = new PiRuntime(join(root, 'pi'))
const config = {
  id: 'real-project-local',
  revision: 1,
  name: 'WebGoat protocol fixture',
  modelId: 'fixture',
  baseUrl: model.baseUrl,
  api: 'openai-completions',
  secretRef: 'qa-fake'
}
h.db.run(
  'INSERT INTO model_configs(id,name,base_url,model_id,secret_ref,revision) VALUES(?,?,?,?,?,?)',
  config.id,
  config.name,
  config.baseUrl,
  config.modelId,
  config.secretRef,
  1
)
h.chains.analysis = new PathAnalysisService(
  h.repo,
  h.query,
  (input, signal) =>
    runAgentLoop(
      runtime,
      { getConfig: async () => config, readSecret: async () => 'local-fixture-key' },
      input,
      signal
    ),
  true
)
const reports = new ReportService(h.db, h.dataRoot)
try {
  const project = await importLocal(h.sources, {
    projectName: 'Pinned WebGoat SQL lesson',
    path: source
  })
  const prepared = await h.chains.action('prepare', { projectId: project.projectId }),
    scope = { projectId: project.projectId, runId: prepared.runId }
  const paths = prepared.pathIds.map((pathId) => h.repo.detail({ ...scope, pathId }))
  const sinkLine =
    bytes
      .toString('utf8')
      .split('\n')
      .findIndex((line) => line.includes('statement.executeQuery(query)')) + 1
  const selected = paths.find(
    (p) => p.sourceRef?.includes('completed') && p.steps.some((s) => s.edge.callLine === sinkLine)
  )
  assert.ok(selected, 'No actual HTTP-to-SQL candidate at pinned source sink')
  await authorize(h, scope, config.id)
  await h.chains.action('analyze', { ...scope, pathId: selected.pathId, modelConfigId: config.id })
  await h.chains.analysis.waitForIdle()
  const detail = h.repo.detail({ ...scope, pathId: selected.pathId })
  assert.equal(detail.verdict, 'unknown')
  assert.ok(detail.steps.every((s) => s.evidence.length > 0))
  const fixed = await h.query.action('query', {
    ...scope,
    language: 'java',
    operation: 'read',
    filePath: 'SqlInjectionLesson5.java',
    line: sinkLine - 16,
    endLine: sinkLine
  })
  assert.ok(fixed.items[0].text.includes('statement.executeQuery(query)'))
  const report = await reports.action('generate', scope)
  assert.equal(report.status, 'ready', report.errorCode)
  // Independent source review, deliberately not written as a human UI sign-off.
  const review = {
    reviewer: 'Codex source inspection; no owner/human sign-off asserted',
    conclusion: 'static SQL injection supported for this teaching endpoint',
    mapping: [
      { from: 'completed(String query)', at: 55, to: 'injectableQuery(query)', callAt: 57 },
      {
        from: 'injectableQuery(String query)',
        at: 60,
        to: 'Statement.executeQuery(query)',
        sinkAt: sinkLine
      }
    ],
    defense: 'no binding or input validation in the reviewed flow',
    scope:
      'single original file at pinned commit; external framework/dependency analysis is not complete',
    expectedProductLimit:
      'protocol fixture intentionally unknown; source review is separate from machine verdict'
  }
  await writeResult(root, 'result.json', {
    ok: true,
    repository: 'https://github.com/WebGoat/WebGoat',
    commit,
    upstreamPath,
    sha256: expectedHash,
    license: 'GPL-2.0-or-later (upstream file header)',
    scope: 'fixed one-file excerpt of a real project; no full-project coverage claim',
    project: scope,
    candidateCount: prepared.candidateCount,
    pathId: selected.pathId,
    actualMachineVerdict: detail.verdict,
    sourceReview: review,
    reportId: report.reportId,
    reportFile: report.filePath
  })
  console.log('QA_REAL_PROJECT_ROOT=' + root)
  console.log(
    'PASS fixed WebGoat source -> actual CodeGraph path -> Pi tools -> saved unknown -> report; independent source review recorded.'
  )
} finally {
  await reports.close()
  await h.close()
  await runtime.close()
  await model.close()
}
