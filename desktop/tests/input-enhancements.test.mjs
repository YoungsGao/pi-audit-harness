import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { auditRequest } from '../src/main/audit-client.ts'
import { createAgentHarness } from './agent-harness.mjs'

test('MOD-04 actual Pi transport sends zero requests when resolved configuration differs or transmission audit cannot commit', async (t) => {
  for (const mode of ['changed-config', 'write-failure']) {
    const h = await createAgentHarness(t)
    if (mode === 'changed-config') {
      const original = h.ports.getConfig
      h.ports.getConfig = async (id) => ({ ...(await original(id)), revision: 2 })
    } else
      h.db.exec(
        "CREATE TRIGGER reject_transmission BEFORE INSERT ON source_transmissions BEGIN SELECT RAISE(ABORT,'fixture'); END"
      )
    await h.chains.action('analyze', {
      ...h.scope,
      pathId: h.prepared.pathIds[0],
      modelConfigId: 'model'
    })
    await h.chains.analysis.waitForIdle()
    assert.equal(h.model.requests.length, 0, mode)
    assert.equal(h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[0] }).status, 'failed')
    assert.equal(h.repo.scans.statistics(h.scope.projectId, h.scope.runId).pending, 1)
  }
})

test('SRC-03 detects damaged saved bytes without falling back to mutable source; legacy tasks explicitly lack snapshots', async (t) => {
  const h = await fixture(t)
  h.db.exec('DROP TRIGGER immutable_snapshot_files_update')
  h.db.run('UPDATE snapshot_files SET content=?', Buffer.from('corrupt'))
  await assert.rejects(
    h.query.action('read', { ...h.scope, filePath: 'Demo.java', startLine: 1 }),
    { code: 'SNAPSHOT_CORRUPT' }
  )
  h.repo.scans.begin(
    h.scope.projectId,
    'legacy-without-snapshot',
    h.project.sourceStamp,
    h.prepared.rulesVersion
  )
  await assert.rejects(
    h.chains.action('snapshot', { ...h.scope, runId: 'legacy-without-snapshot' }),
    { code: 'SNAPSHOT_MISSING' }
  )
})

test('MOD-04 observed-model write failure settles failed unknown without an unhandled subscriber exception', async (t) => {
  const h = await createAgentHarness(t)
  h.db.exec(
    "CREATE TRIGGER reject_observed_model BEFORE UPDATE ON source_transmissions BEGIN SELECT RAISE(ABORT,'fixture'); END"
  )
  await h.chains.action('analyze', {
    ...h.scope,
    pathId: h.prepared.pathIds[0],
    modelConfigId: 'model'
  })
  await h.chains.analysis.waitForIdle()
  const detail = h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[0] })
  assert.equal(detail.status, 'failed')
  assert.equal(detail.verdict, 'unknown')
  assert.match(detail.summary, /DISCLOSURE_RECORD_FAILED/)
  assert.equal(h.model.requests.length, 1)
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-input-')),
    path = join(root, 'source')
  await mkdir(path)
  const text =
    'class Demo {\n @GetMapping("/q") void query(String q) {\n  custom.lookup(q);\n }\n}\n'
  await writeFile(join(path, 'Demo.java'), text)
  const db = openStorage(join(root, 'runtime')),
    sources = new SourceRepository(db)
  const project = await importLocal(sources, { projectName: 'snapshot fixture', path })
  const query = new CodeQueryService(sources),
    repo = new CallChainRepository(db),
    chains = new CallChainService(repo, query)
  db.run(
    "INSERT INTO model_configs (id,name,base_url,model_id,revision) VALUES ('model','fake','http://127.0.0.1:1/v1','fixture',1)"
  )
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  const scope = { projectId: project.projectId, runId: prepared.runId }
  const manual = {
    ...scope,
    filePath: 'Demo.java',
    line: 3,
    ruleId: 'JAVA-SQL-STATEMENT',
    note: '调查自定义查询 API'
  }
  t.after(async () => {
    await chains.close()
    await query.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, path, text, db, sources, project, query, repo, chains, prepared, scope, manual }
}

test('SRC-03 persists exact bytes, manifest/ignore scope and read-only task binding; source deletion cannot move old evidence', async (t) => {
  const h = await fixture(t)
  const snapshot = await h.chains.action('snapshot', h.scope)
  assert.equal(snapshot.files[0].size, Buffer.byteLength(h.text))
  assert.equal(snapshot.files[0].sha256.length, 64)
  assert.ok(snapshot.ignored.some((s) => s.includes('非 Java')))
  await rm(h.path, { recursive: true })
  const read = await h.query.action('read', {
    ...h.scope,
    filePath: 'Demo.java',
    startLine: 1,
    endLine: 5
  })
  assert.equal(read.text, h.text.trimEnd())
  assert.throws(() => h.db.run('UPDATE snapshot_files SET content=?', Buffer.from('changed')), {
    code: 'DB_QUERY_FAILED'
  })
  assert.throws(() => h.db.run('DELETE FROM run_snapshots'), { code: 'DB_QUERY_FAILED' })
  const reopened = openStorage(join(h.root, 'runtime'))
  try {
    assert.equal(
      new SourceRepository(reopened).snapshots.read(h.scope.projectId, h.scope.runId, 'Demo.java'),
      h.text
    )
  } finally {
    reopened.close()
  }
  await assert.rejects(h.chains.action('snapshot', { ...h.scope, projectId: 'other' }), {
    code: 'SNAPSHOT_MISSING'
  })
})

test('MOD-04 denies all fresh starts before consent, reuses same snapshot, rejects stale previews and records actual configuration', async (t) => {
  const h = await fixture(t),
    saved = await h.chains.action('manualRisk', h.manual),
    pathId = saved.pathIds[0]
  let reviews = 0
  h.chains.analysis = new PathAnalysisService(h.repo, h.query, async (input) => {
    reviews++
    input.authorizeModel({
      id: 'model',
      revision: 1,
      baseUrl: 'http://127.0.0.1:1/v1',
      modelId: 'fixture'
    })
    input.observedModel('fixture-observed')
    return {
      verdict: 'unknown',
      summary: '待核实',
      steps: input.evidence.map((e, stepIndex) => ({
        stepIndex,
        dangerous: null,
        reason: '待核实',
        quotes: [e.text]
      }))
    }
  })
  const start = { ...h.scope, pathId, modelConfigId: 'model' }
  await assert.rejects(h.chains.action('analyze', start), { code: 'SOURCE_DISCLOSURE_REQUIRED' })
  await assert.rejects(h.chains.action('analyzePending', { ...h.scope, modelConfigId: 'model' }), {
    code: 'SOURCE_DISCLOSURE_REQUIRED'
  })
  assert.throws(
    () => h.chains.openStream({ ...h.scope, chainId: pathId, modelConfigId: 'model' }),
    { code: 'SOURCE_DISCLOSURE_REQUIRED' }
  )
  assert.equal(reviews, 0)
  assert.equal(h.repo.scans.statistics(h.scope.projectId, h.scope.runId).pending, 1)
  const preview = await h.chains.action('disclosure', { ...h.scope, modelConfigId: 'model' })
  assert.equal(preview.authorized, false)
  await h.chains.action('authorize', {
    ...h.scope,
    modelConfigId: 'model',
    scopeKey: preview.scopeKey
  })
  await h.chains.action('analyze', start)
  await h.chains.analysis.waitForIdle()
  assert.equal(reviews, 1)
  assert.equal(h.db.get('SELECT * FROM source_transmissions').observed_model_id, 'fixture-observed')
  const next = await h.chains.action('prepare', { projectId: h.scope.projectId })
  assert.equal(
    (await h.chains.action('disclosure', { ...h.scope, runId: next.runId, modelConfigId: 'model' }))
      .authorized,
    true
  )
  h.db.run("UPDATE model_configs SET revision=2,model_id='changed' WHERE id='model'")
  await assert.rejects(
    h.chains.action('authorize', {
      ...h.scope,
      modelConfigId: 'model',
      scopeKey: preview.scopeKey
    }),
    { code: 'DISCLOSURE_SCOPE_CHANGED' }
  )
  assert.equal(
    (await h.chains.action('disclosure', { ...h.scope, modelConfigId: 'model' })).authorized,
    false
  )
  assert.throws(
    () =>
      h.repo.scans.disclosure.beforeSend(preview, pathId, 1, {
        id: 'model',
        revision: 2,
        baseUrl: preview.baseUrl,
        modelId: 'changed'
      }),
    { code: 'DISCLOSURE_SCOPE_CHANGED' }
  )
})

test('SCAN-02 authenticates fixed routes, validates snapshot positions and idempotently queues custom calls with independent manual provenance', async (t) => {
  const h = await fixture(t)
  const server = await startHttpServer('fixture-token', {
    chainAction: (a, input, signal) => h.chains.action(a, input, signal)
  })
  t.after(() => server.close())
  const send = (a, input) => auditRequest(server.port, 'fixture-token', a, input)
  assert.equal(
    (await fetch(`http://127.0.0.1:${server.port}/chains/manualRisk`, { method: 'POST' })).status,
    401
  )
  assert.equal((await send('snapshot', h.scope)).ok, true)
  const bad = await send('manualRisk', { ...h.manual, line: 99 })
  assert.equal(bad.error.code, 'MANUAL_LOCATION_INVALID')
  const missingLine = { ...h.manual }
  delete missingLine.line
  assert.equal((await send('manualRisk', missingLine)).error.code, 'MANUAL_LOCATION_INVALID')
  assert.equal(
    (await send('manualRisk', { ...h.manual, filePath: '../Demo.java' })).error.code,
    'QUERY_FILE_OUT_OF_SCOPE'
  )
  assert.equal(
    (await send('manualRisk', { ...h.manual, functionKey: 'wrong' })).error.code,
    'MANUAL_FUNCTION_INVALID'
  )
  await writeFile(join(h.path, 'Demo.java'), 'changed')
  const saved = await send('manualRisk', h.manual)
  assert.equal(saved.ok, true)
  assert.equal(saved.data.pathIds.length, 1)
  assert.deepEqual((await send('manualRisk', h.manual)).data, saved.data)
  const detail = await send('detail', { ...h.scope, pathId: saved.data.pathIds[0] })
  assert.equal(detail.ok, true)
  assert.equal(detail.data.status, 'pending')
  assert.equal(detail.data.verdict, 'unknown')
  assert.match(detail.data.steps.at(-1).edge.calledFunctionName, /lookup/)
  assert.equal(
    h.repo.manualPoint(h.scope.projectId, h.scope.runId, saved.data.pathIds[0]).note,
    h.manual.note
  )
  assert.equal((await send('disclosure', { ...h.scope, modelConfigId: 'model' })).ok, true)
})
