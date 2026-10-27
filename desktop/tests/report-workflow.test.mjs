import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, unlink, mkdir, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createAgentHarness } from './agent-harness.mjs'
import { ReportService } from '../src/service/reports/service.ts'
import { ReportRepository } from '../src/service/storage/report-repository.ts'
import { verifyReportFile } from '../src/service/reports/files.ts'
import { reportInput, isReportData } from '../src/shared/report-contracts.ts'
import { openStorage } from '../src/service/storage/schema.ts'

async function fixture(t, mode = 'finish') {
  const h = await createAgentHarness(t, mode)
  const reports = new ReportService(h.db, join(h.root, 'runtime'))
  t.after(() => reports.close())
  return { ...h, reports }
}

test('real Pi /report reads saved pending paths without model credentials, publishes a standalone stage report and registers a verified file', async (t) => {
  const h = await fixture(t)
  const report = await h.reports.action('generate', h.scope)
  assert.equal(report.status, 'ready', report.errorCode)
  assert.equal(isReportData('generate', report), true)
  assert.equal(report.stageReport, true)
  assert.equal(report.statistics.pending, 2)
  assert.equal(report.statistics.riskPoints, 0)
  assert.equal(h.model.requests.length, 0)
  const html = await readFile(report.filePath, 'utf8')
  for (const text of [
    '阶段报告',
    h.scope.runId,
    h.prepared.pathIds[0],
    '源码证据',
    '未知项与后续建议',
    'Content-Security-Policy'
  ])
    assert.ok(html.includes(text), text)
  assert.ok(!html.includes('local-fixture-key'))
  const catalog = await h.reports.action('list', h.scope)
  assert.equal(isReportData('list', catalog), true)
  assert.equal(catalog.reports[0].reportId, report.reportId)
  const file = await h.reports.action('file', { ...h.scope, reportId: report.reportId })
  await verifyReportFile(join(h.root, 'runtime'), file)
  assert.equal(file.sha256, report.sha256)
})

test('dangerous paths deduplicate by pathId and risk points by shared Sink/rule; HTML escapes/redacts saved text and historical reports remain immutable across restart and new tasks', async (t) => {
  const h = await fixture(t, 'dangerous')
  await h.chains.action('analyzePending', { ...h.scope, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  h.db.run(
    'UPDATE projects SET name=? WHERE id=?',
    '<script>alert("fixture")</script> api_key="fixture-report-private"',
    h.scope.projectId
  )
  const requests = h.model.requests.length
  const report = await h.reports.action('generate', h.scope)
  assert.equal(report.status, 'ready', report.errorCode)
  assert.equal(report.statistics.dangerous, 2)
  assert.equal(report.statistics.riskPoints, 1)
  assert.equal(report.stageReport, false)
  assert.equal(h.model.requests.length, requests)
  const html = await readFile(report.filePath, 'utf8')
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('fixture-report-private'))
  assert.ok(html.includes('取证范围'))
  h.db.run(
    "UPDATE scan_runs SET state='partial',warnings_json=? WHERE run_id=?",
    JSON.stringify([{ code: 'JAVA_PARSE_FAILED', message: 'fixture coverage warning' }]),
    h.scope.runId
  )
  const partial = await h.reports.action('generate', h.scope)
  assert.equal(partial.stageReport, true)
  assert.ok((await readFile(partial.filePath, 'utf8')).includes('fixture coverage warning'))
  const other = openStorage(join(h.root, 'runtime'))
  try {
    const reopened = new ReportService(other, join(h.root, 'runtime'))
    assert.deepEqual(
      await reopened.action('list', h.scope),
      await h.reports.action('list', h.scope)
    )
    await reopened.action('file', { ...h.scope, reportId: report.reportId })
    await reopened.close()
  } finally {
    other.close()
  }
  const next = await h.chains.action('prepare', { projectId: h.scope.projectId })
  await h.reports.action('generate', { projectId: h.scope.projectId, runId: next.runId })
  assert.equal(await readFile(report.filePath, 'utf8'), html)
  assert.equal(
    (await h.reports.action('list', h.scope)).reports.find(
      (row) => row.reportId === report.reportId
    ).sha256,
    report.sha256
  )
})

test('fixed report scope refuses client HTML/paths, cross-run opens, tampered and missing files; double generation is bounded', async (t) => {
  const h = await fixture(t)
  for (const extra of [
    { html: '<script>' },
    { filePath: 'C:\\other.html' },
    { apiKey: 'fixture-only' }
  ])
    await assert.rejects(h.reports.action('generate', { ...h.scope, ...extra }), {
      code: 'REPORT_INVALID_INPUT'
    })
  assert.throws(() => reportInput('open-anything', h.scope))
  const first = h.reports.action('generate', h.scope)
  await assert.rejects(h.reports.action('generate', h.scope), { code: 'REPORT_BUSY' })
  const report = await first
  const scope = { ...h.scope, reportId: report.reportId }
  await assert.rejects(h.reports.action('file', { ...scope, runId: 'other' }), {
    code: 'REPORT_NOT_FOUND'
  })
  await writeFile(report.filePath, '<html>modified fixture</html>')
  await assert.rejects(h.reports.action('file', scope), { code: 'REPORT_FILE_CHANGED' })
  await unlink(report.filePath)
  await assert.rejects(h.reports.action('file', scope), { code: 'REPORT_FILE_MISSING' })
  assert.equal((await h.reports.action('list', h.scope)).reports[0].status, 'ready') // Historical generation status; opening independently verifies current file.
})

test('a phase report can be generated while the audit model is still running without interrupting its Pi runtime', async (t) => {
  const h = await fixture(t, 'hold')
  await h.chains.action('analyze', {
    ...h.scope,
    pathId: h.prepared.pathIds[0],
    modelConfigId: 'model'
  })
  const deadline = Date.now() + 5000
  while (h.model.requests.length === 0) {
    if (Date.now() > deadline) throw Error('fixture request timeout')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const report = await h.reports.action('generate', h.scope)
  assert.equal(report.status, 'ready', report.errorCode)
  assert.equal(report.stageReport, true)
  assert.equal(report.statistics.analyzing, 1)
  assert.equal(report.statistics.pending, 1)
  assert.equal(h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[0] }).status, 'analyzing')
  assert.equal(h.model.requests.length, 1)
  await h.chains.analysis.close()
})

test('a report directory junction cannot redirect generated HTML outside the managed reports folder', async (t) => {
  const h = await fixture(t)
  const outside = join(h.root, 'outside-reports')
  const link = join(h.root, 'runtime', 'reports')
  await mkdir(outside)
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  try {
    const report = await h.reports.action('generate', h.scope)
    assert.equal(report.status, 'failed')
    assert.equal(report.errorCode, 'REPORT_UNSAFE_FILE')
    assert.deepEqual(await readdir(outside), [])
  } finally {
    await unlink(link)
  }
})

test('artifact and database write failures have saved failed states; unwritable failure status is explicit and startup recovery settles pending records', async (t) => {
  const h = await fixture(t)
  await writeFile(join(h.root, 'runtime', 'reports'), 'fixture directory obstruction')
  const broken = await h.reports.action('generate', h.scope)
  assert.equal(broken.status, 'failed')
  assert.equal(broken.errorCode, 'REPORT_GENERATION_FAILED')
  await unlink(join(h.root, 'runtime', 'reports'))
  h.db.exec(
    "CREATE TRIGGER reject_ready BEFORE UPDATE ON reports WHEN NEW.status='ready' BEGIN SELECT RAISE(ABORT,'fixture'); END"
  )
  const dbFailed = await h.reports.action('generate', h.scope)
  assert.equal(dbFailed.status, 'failed')
  assert.equal(dbFailed.errorCode, 'DB_QUERY_FAILED')
  h.db.exec('DROP TRIGGER reject_ready')
  h.db.exec(
    "CREATE TRIGGER reject_reports BEFORE UPDATE ON reports BEGIN SELECT RAISE(ABORT,'fixture'); END"
  )
  await assert.rejects(h.reports.action('generate', h.scope), { code: 'REPORT_PERSISTENCE_FAILED' })
  await assert.rejects(h.reports.action('list', h.scope), { code: 'REPORT_PERSISTENCE_FAILED' })
  h.db.exec('DROP TRIGGER reject_reports')
  const repo = new ReportRepository(h.db)
  repo.recover()
  assert.equal(
    repo.list(h.scope.projectId, h.scope.runId).reports.some((r) => r.status === 'pending'),
    false
  )
  assert.ok(
    repo
      .list(h.scope.projectId, h.scope.runId)
      .reports.some((r) => r.errorCode === 'REPORT_INTERRUPTED')
  )
})
