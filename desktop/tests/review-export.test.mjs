import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, readdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentHarness } from './agent-harness.mjs'
import { ReviewRepository } from '../src/service/storage/review-repository.ts'
import { ReviewService } from '../src/service/reviews/service.ts'
import { ReportService } from '../src/service/reports/service.ts'
import { savedReportSnapshot } from '../src/service/reports/snapshot.ts'
import { openStorage, migrations, migrate } from '../src/service/storage/schema.ts'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { defaultReportFilter, isReportData, reportInput } from '../src/shared/report-contracts.ts'
import { reviewInput, isReviewData } from '../src/shared/review-contracts.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { reviewRequest } from '../src/main/review-client.ts'
import { reportRequest } from '../src/main/report-client.ts'
import { saveReportCopy } from '../src/main/report-export.ts'
import { pathGraphNodes, relatedPaths, relationLabel } from '../src/shared/call-path-view.ts'
import { createServer } from 'node:http'

async function fixture(t, mode = 'finish') {
  const h = await createAgentHarness(t, mode),
    reviews = new ReviewService(h.db, h.query),
    repo = new ReviewRepository(h.db),
    reports = new ReportService(h.db, join(h.root, 'runtime'))
  t.after(() => reports.close())
  return {
    ...h,
    reviews,
    reviewRepo: repo,
    reports,
    pathScope: { ...h.scope, pathId: h.prepared.pathIds[0] }
  }
}
async function save(h, scope, status, note) {
  const before = await h.reviews.action('get', scope)
  return h.reviews.action('save', {
    ...scope,
    expectedRevision: before.revision,
    baselineVersion: before.current.version,
    status,
    note
  })
}
test('REP-01 schema v11 appends immutable review history and default HTML metadata without changing historical checksums', async (t) => {
  const h = await fixture(t),
    db = new LocalDatabase(join(h.root, 'v10'))
  migrate(db, migrations.slice(0, 10))
  const history = db.all('SELECT * FROM schema_migrations ORDER BY version')
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 12)
  assert.deepEqual(
    db.all('SELECT * FROM schema_migrations WHERE version<=10 ORDER BY version'),
    history
  )
  db.close()
  const review = await save(h, h.pathScope, 'confirmed', '人工确认，依据当前快照。')
  assert.equal(review.revision, 1)
  assert.throws(() => h.db.exec("UPDATE path_review_versions SET note='changed'"), {
    code: 'DB_QUERY_FAILED'
  })
  assert.throws(() => h.db.exec('DELETE FROM path_review_versions'), { code: 'DB_QUERY_FAILED' })
})
test('REP-01 human states and notes are independent, versioned, restart-safe and conflict on changed machine baselines', async (t) => {
  const h = await fixture(t),
    before = h.db.all('SELECT * FROM path_steps ORDER BY path_id,step_index'),
    pathBefore = h.repo.detail(h.pathScope)
  const first = await h.reviews.action('get', h.pathScope)
  assert.equal(first.status, 'unreviewed')
  assert.equal(first.revision, 0)
  const one = await save(
    h,
    h.pathScope,
    'false_positive',
    '<script>human-note</script> api_key="must-not-export-private"'
  )
  assert.equal(isReviewData('save', one), true)
  assert.equal(one.stale, false)
  assert.ok(!one.note.includes('must-not-export-private'))
  assert.deepEqual(h.db.all('SELECT * FROM path_steps ORDER BY path_id,step_index'), before)
  assert.deepEqual(h.repo.detail(h.pathScope), pathBefore)
  await assert.rejects(
    h.reviews.action('save', {
      ...h.pathScope,
      expectedRevision: 0,
      baselineVersion: first.current.version,
      status: 'confirmed',
      note: 'old draft'
    }),
    { code: 'REVIEW_CONFLICT' }
  )
  h.db.run(
    "UPDATE call_paths SET result_summary='new saved machine result',updated_at=? WHERE path_id=?",
    new Date(Date.now() + 1000).toISOString(),
    h.pathScope.pathId
  )
  const changed = await h.reviews.action('get', h.pathScope)
  assert.equal(changed.stale, true)
  assert.equal(changed.status, 'false_positive')
  await assert.rejects(
    h.reviews.action('save', {
      ...h.pathScope,
      expectedRevision: 1,
      baselineVersion: one.current.version,
      status: 'confirmed',
      note: 'stale machine'
    }),
    { code: 'REVIEW_MACHINE_CHANGED' }
  )
  const two = await save(h, h.pathScope, 'needs_more_info', '补充来源与防护证据')
  assert.equal(two.revision, 2)
  assert.equal(two.stale, false)
  const reopened = openStorage(join(h.root, 'runtime'))
  try {
    assert.deepEqual(new ReviewRepository(reopened).get(h.pathScope), two)
  } finally {
    reopened.close()
  }
  assert.equal(h.model.requests.length, 0)
})
test('UI-02 graph uses actual ordered relationships, scoped branch candidates and saved defense; source inspector reads pinned caller/callee only', async (t) => {
  const h = await fixture(t),
    detail = h.repo.detail(h.pathScope)
  const nodes = pathGraphNodes(detail)
  assert.equal(nodes.length, detail.steps.length + 1)
  assert.equal(nodes[0].kind, 'source')
  assert.equal(nodes.at(-1).kind, 'sink')
  const patched = structuredClone(detail)
  patched.steps[0].propagation.defense = { status: 'blocked', reason: 'saved check', quotes: ['q'] }
  assert.equal(pathGraphNodes(patched)[0].defense, true)
  assert.notEqual(relationLabel('confirmed'), relationLabel('candidate'))
  const listing = h.repo.list(h.scope)
  assert.equal(relatedPaths(detail, listing.paths).length, 1)
  assert.equal(
    relatedPaths(
      detail,
      listing.paths.map((p) => ({ ...p, runId: 'other' }))
    ).length,
    0
  )
  const before = h.db.all('SELECT evidence_json FROM path_steps ORDER BY path_id,step_index')
  await writeFile(join(h.source, 'Demo.java'), 'class ChangedDisk {}')
  for (const target of ['caller', 'callee']) {
    const source = await h.reviews.action('source', { ...h.pathScope, stepIndex: 0, target })
    assert.equal(isReviewData('source', source), true)
    assert.ok(source.text.includes(target === 'caller' ? 'query(q)' : 'executeQuery'))
    assert.ok(!source.text.includes('ChangedDisk'))
  }
  await assert.rejects(
    h.reviews.action('source', { ...h.pathScope, stepIndex: 55, target: 'caller' }),
    { code: 'PATH_SOURCE_UNAVAILABLE' }
  )
  await assert.rejects(
    h.reviews.action('source', {
      ...h.pathScope,
      stepIndex: 0,
      target: 'caller',
      filePath: '../outside.java'
    }),
    { code: 'REVIEW_INVALID_INPUT' }
  )
  assert.deepEqual(
    h.db.all('SELECT evidence_json FROM path_steps ORDER BY path_id,step_index'),
    before
  )
  assert.equal(h.model.requests.length, 0)
})
test('REP-01 review HTTP/main boundaries enforce input, path identity, safe DTO and correct step target even on HTTP 200', async (t) => {
  const h = await fixture(t),
    token = 'review-fixture-token'
  const server = await startHttpServer(token, {
    reviewAction: (a, v, s) => h.reviews.action(a, v, s)
  })
  t.after(() => server.close())
  assert.equal(
    (await fetch(`http://127.0.0.1:${server.port}/reviews/get`, { method: 'POST' })).status,
    401
  )
  const record = await reviewRequest(server.port, token, 'get', h.pathScope)
  assert.equal(record.ok, true)
  for (const extra of [{ sql: 'SELECT 1' }, { apiKey: 'private' }, { filePath: 'C:/outside.java' }])
    assert.throws(() => reviewInput('get', { ...h.pathScope, ...extra }))
  assert.throws(() =>
    reviewInput('save', {
      ...h.pathScope,
      status: 'safe',
      note: 'x',
      expectedRevision: 0,
      baselineVersion: '0'.repeat(64)
    })
  )
  const cross = await reviewRequest(server.port, token, 'get', {
    ...h.pathScope,
    runId: 'another-run'
  })
  assert.equal(cross.error.code, 'REVIEW_SCOPE_NOT_FOUND')
  const source = await h.reviews.action('source', {
    ...h.pathScope,
    stepIndex: 0,
    target: 'caller'
  })
  const forged = createServer((_req, res) =>
    res.end(JSON.stringify({ ok: true, requestId: 'forged', data: { ...source, stepIndex: 1 } }))
  )
  await new Promise((resolve) => forged.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((r) => forged.close(r)))
  assert.equal(
    (
      await reviewRequest(forged.address().port, token, 'source', {
        ...h.pathScope,
        stepIndex: 0,
        target: 'caller'
      })
    ).error.code,
    'REVIEW_TRANSPORT_FAILED'
  )
  assert.equal(isReviewData('get', { ...record.data, apiKey: 'forbidden' }), false)
})
test('REP-03 filtered JSON matches preview and preserves contradictory machine/human results with escaped/redacted text, evidence and immutable history', async (t) => {
  const h = await fixture(t, 'dangerous')
  await h.chains.action('analyzePending', { ...h.scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  const review = await save(
    h,
    h.pathScope,
    'false_positive',
    '<script>review-marker-v1</script> api_key="export-private-fixture"'
  )
  const filter = { ...defaultReportFilter, reviewStatus: 'false_positive' },
    preview = await h.reports.action('preview', { ...h.scope, filter })
  assert.equal(isReportData('preview', preview), true)
  assert.equal(preview.statistics.paths, 1)
  assert.equal(preview.allStatistics.paths, 2)
  assert.equal(preview.statistics.dangerous, 1)
  assert.equal(preview.reviewCounts.false_positive, 1)
  const requests = h.model.requests.length
  const record = await h.reports.action('export', {
    ...h.scope,
    format: 'json',
    filter,
    expectedSnapshotKey: preview.snapshotKey
  })
  assert.equal(record.status, 'ready', record.errorCode)
  assert.equal(isReportData('export', record), true, JSON.stringify(record))
  assert.equal(record.stageReport, true)
  assert.equal(record.format, 'json')
  const raw = await readFile(record.filePath, 'utf8'),
    json = JSON.parse(raw)
  assert.deepEqual(json.statistics, preview.statistics)
  assert.equal(json.snapshotKey, preview.snapshotKey)
  assert.equal(json.paths.length, 1)
  assert.equal(json.paths[0].verdict, 'dangerous')
  assert.equal(json.humanReviews[0].status, 'false_positive')
  assert.equal(json.humanReviews[0].revision, review.revision)
  assert.ok(json.paths[0].steps.every((s) => s.evidence.length > 0))
  assert.ok(!raw.includes('<script>'))
  assert.ok(!raw.includes('export-private-fixture'))
  assert.ok(!raw.includes('local-fixture-key'))
  assert.ok(raw.includes('\\u003cscript\\u003e'))
  assert.ok(json.stageReasons.some((t) => t.includes('筛选导出')))
  await save(h, h.pathScope, 'confirmed', 'review-marker-v2')
  assert.equal(await readFile(record.filePath, 'utf8'), raw)
  assert.equal(h.model.requests.length, requests)
  const jsonFile = await h.reports.action('file', { ...h.scope, reportId: record.reportId })
  assert.equal(jsonFile.format, 'json')
})
test('REP-03 HTML shares human-review snapshot and filters, while a stale preview produces a registered failure instead of exporting changed results', async (t) => {
  const h = await fixture(t),
    filter = { ...defaultReportFilter }
  await save(h, h.pathScope, 'confirmed', 'human-version-one')
  const preview = await h.reports.action('preview', { ...h.scope, filter })
  const html = await h.reports.action('export', {
    ...h.scope,
    format: 'html',
    filter,
    expectedSnapshotKey: preview.snapshotKey
  })
  assert.equal(html.status, 'ready', html.errorCode)
  const raw = await readFile(html.filePath, 'utf8')
  assert.ok(raw.includes('人工确认'))
  assert.ok(raw.includes('human-version-one'))
  assert.ok(raw.includes('机器结论'))
  assert.ok(raw.includes('阶段、结束原因'))
  await save(h, h.pathScope, 'needs_more_info', 'human-version-two')
  const rejected = await h.reports.action('export', {
    ...h.scope,
    format: 'json',
    filter,
    expectedSnapshotKey: preview.snapshotKey
  })
  assert.equal(rejected.status, 'failed')
  assert.equal(rejected.errorCode, 'REPORT_SNAPSHOT_CHANGED')
  assert.equal(await readFile(html.filePath, 'utf8'), raw)
  const empty = await h.reports.action('preview', {
    ...h.scope,
    filter: { ...filter, reviewStatus: 'false_positive' }
  })
  assert.equal(empty.statistics.paths, 0)
  assert.equal(empty.statistics.unknown, 0)
  assert.equal(empty.stageReport, true)
})
test('REP-03 stage exports include pending/unknown, task ending metadata and coverage limits; no paths are promoted to safety', async (t) => {
  const h = await fixture(t)
  h.db.run(
    "UPDATE audit_runs SET status='failed',stage='interrupted',error_code='FIXTURE_STOP',finished_at=? WHERE id=?",
    new Date().toISOString(),
    h.scope.runId
  )
  const snapshot = savedReportSnapshot(h.db, h.scope.projectId, h.scope.runId)
  assert.equal(snapshot.stageReport, true)
  assert.ok(snapshot.stageReasons.some((r) => r.includes('FIXTURE_STOP')))
  assert.ok(snapshot.stageReasons.some((r) => r.includes('待分析')))
  assert.equal(snapshot.run.errorCode, 'FIXTURE_STOP')
  assert.ok(snapshot.run.finishedAt)
  assert.ok(snapshot.paths.every((p) => p.verdict === 'unknown'))
  assert.equal(snapshot.statistics.safe, 0)
})
test('REP-03 native-save helper copies verified bytes outside runtime only and rejects tampering, format changes and internal-directory junctions', async (t) => {
  const h = await fixture(t),
    filter = { ...defaultReportFilter }
  const preview = await h.reports.action('preview', { ...h.scope, filter }),
    record = await h.reports.action('export', {
      ...h.scope,
      format: 'json',
      filter,
      expectedSnapshotKey: preview.snapshotKey
    })
  const file = await h.reports.action('file', { ...h.scope, reportId: record.reportId }),
    out = join(h.root, 'copies')
  await mkdir(out)
  const saved = await saveReportCopy(join(h.root, 'runtime'), file, join(out, 'result.json'))
  assert.deepEqual(await readFile(saved), await readFile(record.filePath))
  await assert.rejects(saveReportCopy(join(h.root, 'runtime'), file, join(out, 'result.html')), {
    code: 'REPORT_SAVE_EXTENSION'
  })
  await assert.rejects(
    saveReportCopy(join(h.root, 'runtime'), file, join(h.root, 'runtime', 'other.json')),
    { code: 'REPORT_SAVE_INTERNAL' }
  )
  const link = join(h.root, 'runtime-link')
  await symlink(join(h.root, 'runtime'), link, 'junction')
  await assert.rejects(saveReportCopy(join(h.root, 'runtime'), file, join(link, 'other.json')), {
    code: 'REPORT_SAVE_INTERNAL'
  })
  await writeFile(record.filePath, '{"tampered":true}')
  await assert.rejects(saveReportCopy(join(h.root, 'runtime'), file, join(out, 'second.json')), {
    code: 'REPORT_FILE_CHANGED'
  })
  assert.deepEqual(await readdir(out), ['result.json'])
})
test('REP-03 authenticated preview/export clients reject wrong filters and unsafe payloads; legacy generate/list/file stay compatible', async (t) => {
  const h = await fixture(t),
    token = 'export-token'
  const server = await startHttpServer(token, {
    reportAction: (a, v, s) => h.reports.action(a, v, s)
  })
  t.after(() => server.close())
  const request = { ...h.scope, filter: { ...defaultReportFilter } }
  const preview = await reportRequest(server.port, token, 'preview', request)
  assert.equal(preview.ok, true)
  const result = await reportRequest(server.port, token, 'export', {
    ...request,
    format: 'json',
    expectedSnapshotKey: preview.data.snapshotKey
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(result.data.format, 'json')
  for (const extra of [{ filePath: 'C:/x.json' }, { html: '<script>' }, { apiKey: 'private' }])
    assert.throws(() =>
      reportInput('export', {
        ...request,
        format: 'json',
        expectedSnapshotKey: preview.data.snapshotKey,
        ...extra
      })
    )
  assert.throws(() =>
    reportInput('preview', { ...h.scope, filter: { ...defaultReportFilter, reviewStatus: 'safe' } })
  )
  const legacy = await reportRequest(server.port, token, 'generate', h.scope)
  assert.equal(legacy.ok, true)
  assert.equal(legacy.data.format, 'html')
})
