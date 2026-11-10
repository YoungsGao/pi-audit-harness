import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openHarness, loadManifest } from '../qa/harness.mjs'
import { isAuditData } from '../src/shared/audit-validation.ts'
import { pathGraphNodes } from '../src/shared/call-path-view.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { nonThinkingPayload } from '../src/service/provider-compat.ts'
import { decodeCards } from '../qa/reference-decoder.mjs'

test('QA-01 acceptance split has 18 versioned cases: two positive/two blocked per category and six unknown', async () => {
  const manifest = await loadManifest()
  assert.equal(manifest.cases.length, 18)
  assert.equal(new Set(manifest.cases.map((c) => c.sha256)).size, 18)
  for (const category of ['sql-injection', 'command-injection', 'path-traversal'])
    for (const verdict of ['dangerous', 'safe'])
      assert.equal(
        manifest.cases.filter((c) => c.category === category && c.expected === verdict).length,
        2
      )
  assert.equal(manifest.cases.filter((c) => c.expected === 'unknown').length, 6)
})
test('QA-01 evidence-card decoder accepts only registered same-case IDs and rejects fabricated/cross-case citations', () => {
  const material = [{ id: 'case-a', source: '\n\n\n\n\n\nactual source' }]
  assert.equal(decodeCards('{"case-a":["safe","case-a"]}', material)[0].quote, 'actual source')
  assert.equal(decodeCards('{"case-a":["safe","case-b"]}', material)[0].valid, false)
  assert.equal(decodeCards('{"case-a":["safe","invented source"]}', material)[0].valid, false)
  assert.equal(decodeCards('{"case-a":["arbitrary","body"]}', material)[0].valid, false)
})
test('QA provider compatibility explicitly disables official DeepSeek thinking while preserving other providers and original payload', () => {
  const payload = { model: 'deepseek-flash', reasoning_effort: 'high', messages: [] }
  const clean = nonThinkingPayload('https://api.deepseek.com/v1', payload)
  assert.deepEqual(clean.thinking, { type: 'disabled' })
  assert.equal(clean.reasoning_effort, undefined)
  assert.equal(payload.reasoning_effort, 'high')
  assert.equal(nonThinkingPayload('https://api.deepseek.com.evil.invalid/v1', payload), payload)
  assert.equal(nonThinkingPayload('https://example.invalid/v1', payload), payload)
})

test('QA-02 actual snapshot persists 49 edges / 50 graph nodes, strict DTO accepts it, agent still rejects >16 steps', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'pi-qa-long-')),
    root = join(base, 'd'.repeat(Math.max(1, 112 - base.length - 1))),
    source = join(root, 'source')
  await mkdir(source, { recursive: true })
  const text = [
    'class DeepPath { Statement stmt;',
    ...Array.from(
      { length: 49 },
      (_, i) =>
        `${i === 0 ? '@GetMapping("/deep") ' : ''}void step${i}(String q) throws Exception { ${i < 48 ? `step${i + 1}(q);` : 'stmt.executeQuery(q);'} }`
    ),
    '}'
  ].join('\n')
  await writeFile(join(source, 'DeepPath.java'), text)
  const h = await openHarness(root)
  t.after(async () => {
    await h.close()
    await rm(base, { recursive: true, force: true })
  })
  const project = await importLocal(h.sources, { projectName: 'QA 50 nodes', path: source })
  const prepared = await h.chains.action('prepare', { projectId: project.projectId, maxDepth: 49 })
  const scope = { projectId: project.projectId, runId: prepared.runId, pathId: prepared.pathIds[0] }
  const detail = h.repo.detail(scope)
  assert.equal(
    h.sources.graphs.get(scope.projectId, scope.runId).backend,
    'codegraph',
    'deep profile must use the real graph backend'
  )
  assert.equal(detail.steps.length, 49)
  assert.equal(pathGraphNodes(detail).length, 50)
  assert.equal(isAuditData('detail', detail), true)
  const { PathAnalysisService } = await import('../src/service/chains/path-analysis.ts')
  const analysis = new PathAnalysisService(
    h.repo,
    h.query,
    async () => {
      throw Error('must not execute long-path model')
    },
    true
  )
  assert.throws(() => analysis.start(scope.projectId, scope.runId, scope.pathId, 'unused'), {
    code: 'ANALYSIS_LIMIT'
  })
  await analysis.close()
})
