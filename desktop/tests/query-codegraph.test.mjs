import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { savedReportSnapshot } from '../src/service/reports/snapshot.ts'
import { CodeGraphPool } from '../src/service/query/codegraph-runtime.ts'

async function fixture(t, options = {}, overload = false, extraFiles = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-codegraph-')),
    source = join(root, 'source'),
    runtime = join(root, 'runtime')
  await mkdir(source)
  const web =
    'package demo; class Web { Service service; @GetMapping("/a") String a(String q) throws Exception { service.search(q); return service.search(q); } @GetMapping("/b") String b(String q) throws Exception { return service.search(q); } } @interface GetMapping { String value(); }'
  const service =
    'package demo; class Service { Repo repo; String search(String q) throws Exception { return repo.query(q); } ' +
    (overload ? 'String search(int q) { return "n"; }' : '') +
    ' }'
  const repoText =
    'package demo; import java.sql.Statement; class Repo { Statement stmt; String query(String q) throws Exception { stmt.executeQuery("SELECT "+q); return q; } }'
  for (const [file, text] of Object.entries({
    'Web.java': web,
    'Service.java': service,
    'Repo.java': repoText,
    ...extraFiles
  })) {
    await mkdir(dirname(join(source, file)), { recursive: true })
    await writeFile(join(source, file), text)
  }
  const db = openStorage(runtime),
    sources = new SourceRepository(db),
    project = await importLocal(sources, { projectName: 'graph fixture', path: source })
  const query = new CodeQueryService(sources, { dataRoot: runtime, ...options }),
    repo = new CallChainRepository(db),
    chains = new CallChainService(repo, query)
  t.after(async () => {
    await chains.close()
    await query.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  return {
    root,
    runtime,
    source,
    db,
    sources,
    query,
    repo,
    chains,
    prepared,
    web,
    service,
    scope: { language: 'java', projectId: project.projectId, runId: prepared.runId }
  }
}
test('CodeGraph actual SDK freezes cross-file call sites, candidates, provenance and cache; no JVM needed', async (t) => {
  const h = await fixture(t)
  const binding = h.sources.graphs.get(h.scope.projectId, h.scope.runId)
  assert.ok(binding, JSON.stringify(h.prepared))
  assert.equal(binding.backend, 'codegraph')
  assert.ok(binding.facts.some((f) => f.verification === 'verified-structural'))
  const def = await h.query.action('query', {
    ...h.scope,
    operation: 'definition',
    filePath: 'Web.java',
    line: 1,
    column: h.web.indexOf('search(q)') + 1,
    fallback: false
  })
  assert.equal(def.backend, 'codegraph', JSON.stringify(def))
  assert.equal(def.items[0].symbol.qualifiedName, 'demo.Service.search(String)')
  assert.equal(def.items[0].resolution, 'candidate')
  assert.equal(def.runtime.starts, 1)
  const incoming = await h.query.action('query', {
    ...h.scope,
    operation: 'incomingCalls',
    filePath: 'Service.java',
    line: 1,
    column: h.service.indexOf('search(String') + 1
  })
  assert.equal(incoming.items.length, 3, JSON.stringify(incoming))
  assert.equal(new Set(incoming.items.map((i) => i.callSite.start.column)).size, 3)
  assert.ok(h.prepared.pathIds.length >= 2)
  for (const pathId of h.prepared.pathIds)
    assert.ok(
      h.repo
        .detail({ ...h.scope, pathId })
        .steps.every((s) => s.edge.resolutionStatus !== 'confirmed')
    )
  await writeFile(join(h.source, 'Service.java'), 'class Changed {}')
  const second = await h.query.action('query', {
    ...h.scope,
    operation: 'definition',
    filePath: 'Web.java',
    line: 1,
    column: h.web.indexOf('search(q)') + 1
  })
  assert.deepEqual(second.items, def.items)
  assert.equal(second.runtime.starts, 1)
  const report = savedReportSnapshot(h.db, h.scope.projectId, h.scope.runId)
  assert.deepEqual(report.queryGraph, binding)
  assert.throws(() => h.db.exec('DELETE FROM run_graph_bindings'))
})
test('SCAN-02 manual paths reuse frozen CodeGraph targets and basic identity without rebuilding', async (t) => {
  const repoText =
    'package demo; import java.sql.Statement; class Repo { Statement stmt; Helper custom; String query(String q) throws Exception { custom.lookup(q); stmt.executeQuery("SELECT "+q); return q; } }'
  for (const backend of ['codegraph', 'basic']) {
    const h = await fixture(t, { backend }, false, {
      'Repo.java': repoText,
      'other/Service.java': 'package other; class Service { String search(String q) { return q; } }'
    })
    const scope = { projectId: h.scope.projectId, runId: h.scope.runId }
    const binding = h.sources.graphs.get(scope.projectId, scope.runId)
    const originals = h.prepared.pathIds.map((pathId) => h.repo.detail({ ...scope, pathId }))
    const original = originals[0]
    const beforeEdges = h.db.all('SELECT * FROM call_edges WHERE run_id=?', scope.runId)
    if (backend === 'codegraph') {
      assert.ok(original.steps[0].edge.functionName.startsWith('demo.Web.'))
      const [key] = await readdir(join(h.runtime, 'query-index'))
      const folder = join(h.runtime, 'query-index', key)
      const manifest = JSON.parse(await readFile(join(folder, 'ready.json'), 'utf8'))
      await writeFile(join(folder, manifest.name), 'damaged cache; fixed task facts remain valid')
    }
    const saved = await h.chains.action('manualRisk', {
      ...scope,
      filePath: 'Repo.java',
      line: 1,
      column: repoText.indexOf('lookup(q)') + 1,
      ruleId: original.ruleId,
      note: 'Reuse this task\u2019s fixed call targets.'
    })
    const manual = saved.pathIds.map((pathId) => h.repo.detail({ ...scope, pathId }))
    assert.deepEqual(
      manual.map((path) => JSON.stringify(path.steps.map((step) => step.edge.functionName))).sort(),
      originals
        .map((path) => JSON.stringify(path.steps.map((step) => step.edge.functionName)))
        .sort(),
      backend
    )
    assert.deepEqual(
      manual.map((path) => path.truncated).sort(),
      originals.map((path) => path.truncated).sort()
    )
    assert.deepEqual(h.sources.graphs.get(scope.projectId, scope.runId), binding)
    const existingSink = await h.chains.action('manualRisk', {
      ...scope,
      filePath: 'Repo.java',
      line: 1,
      column: repoText.indexOf('executeQuery(') + 1,
      ruleId: original.ruleId,
      note: 'Reuse the existing automatic Sink and its argument evidence.'
    })
    assert.equal(existingSink.pathIds.length, originals.length)
    for (const edge of beforeEdges)
      assert.deepEqual(h.db.get('SELECT * FROM call_edges WHERE uid=?', edge.uid), edge)
    const status = await h.query.action('query', { ...h.scope, operation: 'status' })
    assert.equal(status.runtime.starts, backend === 'codegraph' ? 1 : 0)
  }
})
test('CodeGraph restores ambiguity erased by upstream same-arity overload choice', async (t) => {
  const h = await fixture(t, {}, true)
  const result = await h.query.action('query', {
    ...h.scope,
    operation: 'definition',
    filePath: 'Web.java',
    line: 1,
    column: h.web.indexOf('search(q)') + 1,
    fallback: false
  })
  assert.equal(result.items.length, 2, JSON.stringify(result))
  assert.ok(result.gaps.includes('GRAPH_AMBIGUOUS_TARGET'))
  assert.ok(result.items.every((i) => i.resolution === 'candidate'))
  assert.ok(
    h.sources.graphs.get(h.scope.projectId, h.scope.runId).gaps.includes('GRAPH_AMBIGUOUS_TARGET')
  )
})
test('CodeGraph persisted projection reopens without process; damage is explicit and snapshot corruption never falls back', async (t) => {
  const h = await fixture(t),
    root = join(h.runtime, 'query-index')
  const fresh = new CodeQueryService(h.sources, { dataRoot: h.runtime })
  t.after(() => fresh.close())
  const request = { ...h.scope, operation: 'symbols', filePath: 'Service.java', fallback: false }
  const result = await fresh.action('query', request)
  assert.equal(result.runtime.starts, 0)
  assert.ok(result.items.length)
  const [key] = await readdir(root),
    folder = join(root, key)
  const manifest = JSON.parse(await readFile(join(folder, 'ready.json'), 'utf8'))
  await writeFile(join(folder, manifest.name), 'damaged')
  const damaged = await fresh.action('query', request)
  assert.equal(damaged.errorCode, 'QUERY_GRAPH_CORRUPT')
  assert.equal(damaged.status, 'failed')
})
test('CodeGraph build budget failure publishes no ready graph; basic is explicit and no implicit Java fallback', async (t) => {
  const h = await fixture(t, { graphTimeoutMs: 1 })
  assert.ok(h.prepared.warnings.some((w) => w.code === 'QUERY_TIMEOUT'))
  assert.equal(h.sources.graphs.get(h.scope.projectId, h.scope.runId).backend, 'basic')
  const result = await h.query.action('query', {
    ...h.scope,
    operation: 'definition',
    filePath: 'Web.java',
    line: 1,
    column: h.web.indexOf('search(q)') + 1
  })
  assert.equal(result.backend, 'basic')
  assert.equal(result.status, 'partial')
  const basic = new CodeQueryService(h.sources, { backend: 'basic' })
  t.after(() => basic.close())
  const caps = await basic.action('query', { ...h.scope, operation: 'capabilities' })
  assert.equal(caps.capabilities[0].semantic, false)
  assert.equal(caps.runtime.starts, 0)
})

test('CodeGraph concurrent prepare shares a worker; cancelled waiter detaches and memory budget kills publication', async (t) => {
  const h = await fixture(t)
  const info = h.query.snapshots.info(h.scope.projectId, h.scope.runId)
  const snapshot = {
    ...h.scope,
    snapshotId: info.snapshotId + '-parallel',
    sourceStamp: info.sourceStamp,
    files: info.files.map((f) => ({
      filePath: f.filePath,
      source: h.sources.snapshots.read(h.scope.projectId, h.scope.runId, f.filePath)
    }))
  }
  const pool = new CodeGraphPool({}, join(h.root, 'parallel')),
    one = new AbortController()
  t.after(() => pool.close())
  const first = pool.artifact(snapshot, one.signal),
    rejection = assert.rejects(first, { code: 'QUERY_CANCELLED' })
  const second = pool.artifact(snapshot, new AbortController().signal)
  one.abort()
  await rejection
  const result = await second
  assert.ok(result.binding.graphDigest)
  assert.equal(pool.status(snapshot).starts, 1)
  const limited = new CodeGraphPool({ graphMemoryMb: 1 }, join(h.root, 'memory'))
  t.after(() => limited.close())
  await assert.rejects(limited.artifact(snapshot, new AbortController().signal), {
    code: 'QUERY_MEMORY_LIMIT'
  })
  assert.equal(limited.status(snapshot).state, 'failed')
})

test('CodeGraph UTF-16/CRLF positions, scope, snapshot corruption, immutable binding and explicit backend changes', async (t) => {
  const h = await fixture(t)
  const info = h.query.snapshots.info(h.scope.projectId, h.scope.runId),
    bad = new CodeQueryService(h.sources, { backend: 'basic' })
  t.after(() => bad.close())
  assert.equal(
    (await bad.action('query', { ...h.scope, operation: 'symbols', filePath: 'Web.java' }))
      .errorCode,
    'RUN_GRAPH_BACKEND_CHANGED'
  )
  const refs = await h.query.action('query', {
    ...h.scope,
    operation: 'references',
    filePath: 'Service.java',
    line: 1,
    column: h.service.indexOf('search(String') + 1
  })
  assert.equal(refs.items.length, 3)
  assert.ok(refs.gaps.includes('GRAPH_REFERENCES_PARTIAL'))
  const symbols = await h.query.action('query', {
    ...h.scope,
    operation: 'symbols',
    filePath: 'Service.java'
  })
  assert.ok(!symbols.gaps.includes('GRAPH_REFERENCES_PARTIAL'))
  const text =
    'package demo; class Emoji { String 中文="😀"; void 调用(){ 目标(); } void 目标(){} }\r\n'
  const snapshot = {
    ...h.scope,
    snapshotId: 'unicode',
    sourceStamp: 'unicode-fixture',
    files: [{ filePath: 'Emoji.java', source: text }]
  }
  const pool = new CodeGraphPool({}, join(h.root, 'unicode'))
  t.after(() => pool.close())
  const artifact = await pool.artifact(snapshot, new AbortController().signal)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(artifact.file, { readOnly: true })
  try {
    const target = pool.nodes(db).find((n) => n.kind === 'method' && n.name === '目标')
    const edge = pool
      .edges(db, pool.nodes(db).find((n) => n.name === '调用').id)
      .find((e) => e.kind === 'calls')
    assert.equal(target.startColumn, text.indexOf('void 目标'))
    assert.equal(edge.column, text.indexOf('目标();'))
  } finally {
    db.close()
  }
  await assert.rejects(
    h.query.action('query', { ...h.scope, operation: 'symbols', filePath: '../outside.java' }),
    { code: 'QUERY_INVALID_INPUT' }
  )
  h.db.exec('DROP TRIGGER immutable_snapshot_files_update')
  // Use the table's actual column names and scope, not current disk text.
  h.db.run("UPDATE snapshot_files SET content=x'00' WHERE snapshot_id=?", info.snapshotId)
  await assert.rejects(
    h.query.action('query', { ...h.scope, operation: 'symbols', filePath: 'Web.java' }),
    { code: 'SNAPSHOT_CORRUPT' }
  )
})
