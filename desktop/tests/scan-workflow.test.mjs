import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { PathAnalysisService } from '../src/service/chains/path-analysis.ts'
import { isAuditData } from '../src/shared/audit-validation.ts'

export async function fixture(t, sources) {
  const root = await mkdtemp(join(tmpdir(), 'pi-scan-')),
    path = join(root, 'source')
  await mkdir(path)
  for (const [name, text] of Object.entries(
    sources ?? {
      'Web.java':
        'package demo; class Web { Service service; @GetMapping("/a") String first(String q) {return service.search(q);} @GetMapping("/b") String second(String q) {return service.search(q);} }',
      'Service.java':
        'package demo; class Service { Repo repo; String search(String q) {return repo.query(q);} }',
      'Repo.java':
        'package demo; class Repo { Statement stmt; String query(String q) {stmt.executeQuery("SELECT x="+q);return q;} }'
    }
  ))
    await writeFile(join(path, name), text)
  const db = openStorage(join(root, 'runtime')),
    sourceRepo = new SourceRepository(db),
    project = await importLocal(sourceRepo, { projectName: 'scan fixture', path })
  const repo = new CallChainRepository(db),
    query = new CodeQueryService(sourceRepo),
    chains = new CallChainService(repo, query)
  t.after(async () => {
    await chains.close()
    await query.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return { db, repo, query, chains, project, path }
}
test('actual cross-file Java calls -> two HTTP candidate paths sharing edges; totals count paths/sinks, never steps', async (t) => {
  const { chains, repo, project, db } = await fixture(t)
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  assert.equal(prepared.state, 'ready')
  assert.equal(isAuditData('prepare', prepared), true)
  assert.equal(isAuditData('runs', repo.scans.runs(project.projectId)), true)
  assert.equal(prepared.pathIds.length, 2)
  const details = prepared.pathIds.map((pathId) =>
    repo.detail({ projectId: project.projectId, runId: prepared.runId, pathId })
  )
  assert.deepEqual(
    details.map((d) => d.steps.length),
    [3, 3]
  )
  assert.equal(details[0].steps[2].edge.uid, details[1].steps[2].edge.uid)
  assert.match(details[0].sourceRef, /^http-entry-candidate:/)
  assert.equal(details[0].truncated, false)
  assert.equal(isAuditData('detail', details[0]), true)
  const stats = repo.scans.statistics(project.projectId, prepared.runId)
  assert.equal(stats.paths, 2)
  assert.equal(stats.sinks, 1)
  assert.equal(stats.edges, 4)
  assert.equal(stats.unknown, 2)
  assert.equal(db.get('SELECT count(*) AS n FROM path_steps').n, 6)
})
test('zero matches, syntax fallback, changed source failure, duplicate-click rejection and recursive limits are explicit', async (t) => {
  const { chains, repo, project, path } = await fixture(t, {
    'Empty.java': 'class Empty { void noRisk(){} }'
  })
  const pending = chains.action('prepare', { projectId: project.projectId })
  await assert.rejects(chains.action('prepare', { projectId: project.projectId }), {
    code: 'SCAN_BUSY'
  })
  assert.equal((await pending).state, 'empty')
  await writeFile(join(path, 'Empty.java'), 'changed')
  await assert.rejects(chains.action('prepare', { projectId: project.projectId }), {
    code: 'QUERY_SOURCE_CHANGED'
  })
  assert.equal(repo.scans.runs(project.projectId).runs[0].state, 'failed')
  const fallback = await fixture(t, {
    'Broken.java': 'class Broken { void q( { stmt.executeQuery(input);'
  })
  const partial = await fallback.chains.action('prepare', { projectId: fallback.project.projectId })
  assert.equal(partial.state, 'partial')
  assert.equal(partial.candidateCount, 1)
  assert.ok(partial.warnings.some((w) => w.code === 'JAVA_PARSE_INCOMPLETE'))
  const recursive = await fixture(t, {
    'Loop.java': 'class Loop { void loop(String q) { loop(q); stmt.executeQuery(q); } }'
  })
  const loop = await recursive.chains.action('prepare', { projectId: recursive.project.projectId })
  assert.equal(loop.truncated, true)
  const detail = recursive.repo.detail({
    projectId: recursive.project.projectId,
    runId: loop.runId,
    pathId: loop.pathIds[0]
  })
  assert.equal(detail.truncationReason, 'recursion')
})
test('real background start, exclusive claim and per-path result do not overwrite shared edge or sibling conclusion', async (t) => {
  const { chains, repo, query, project, db } = await fixture(t)
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  db.run(
    "INSERT INTO model_configs (id,name,base_url,model_id,secret_ref,revision) VALUES ('model','test','http://127.0.0.1','fixture',NULL,1)"
  )
  let release
  const gate = new Promise((r) => {
    release = r
  })
  chains.analysis = new PathAnalysisService(repo, query, async (input) => {
    await gate
    return {
      verdict: 'dangerous',
      summary: '受控测试：仅此路径有风险证据。',
      steps: input.evidence.map((e, i) => ({
        stepIndex: i,
        dangerous: 1,
        reason: 'test evidence',
        quotes: [e.text]
      }))
    }
  })
  const input = {
    projectId: project.projectId,
    runId: prepared.runId,
    pathId: prepared.pathIds[0],
    modelConfigId: 'model'
  }
  assert.equal((await chains.action('analyze', input)).status, 'analyzing')
  await assert.rejects(chains.action('analyze', input), { code: 'ANALYSIS_BUSY' })
  assert.equal(repo.scans.statistics(project.projectId, prepared.runId).analyzing, 1)
  release()
  for (
    let i = 0;
    i < 100 && repo.scans.statistics(project.projectId, prepared.runId).analyzing;
    i++
  )
    await new Promise((r) => setTimeout(r, 10))
  const detail = repo.detail(input)
  assert.equal(detail.status, 'completed')
  assert.equal(detail.dangerous, 1)
  const sibling = repo.detail({ ...input, pathId: prepared.pathIds[1] })
  assert.equal(sibling.dangerous, null)
  assert.equal(sibling.steps[2].dangerous, null)
  assert.equal(repo.scans.statistics(project.projectId, prepared.runId).dangerous, 1)
})

test('same-arity overloads remain unresolved; bounded depth and node budgets are persisted as partial coverage', async (t) => {
  const ambiguous = await fixture(t, {
    'Overloaded.java':
      'class Service { void search(String q) {stmt.executeQuery(q);} void search(int q) {stmt.executeQuery("fixed");} } class Web { Service svc; @GetMapping("/x") void entry(String q) {svc.search(q);} }'
  })
  const partial = await ambiguous.chains.action('prepare', {
    projectId: ambiguous.project.projectId
  })
  assert.equal(partial.state, 'partial')
  assert.ok(partial.unresolvedCalls > 0)
  const detail = ambiguous.repo.detail({
    projectId: ambiguous.project.projectId,
    runId: partial.runId,
    pathId: partial.pathIds[0]
  })
  assert.equal(detail.steps.length, 1)
  assert.match(detail.sourceRef, /^method-boundary:/)
  const normal = await fixture(t)
  const limited = await normal.chains.action('prepare', {
    projectId: normal.project.projectId,
    maxDepth: 1
  })
  const capped = normal.repo.detail({
    projectId: normal.project.projectId,
    runId: limited.runId,
    pathId: limited.pathIds[0]
  })
  assert.equal(capped.truncationReason, 'depth-limit')
  assert.equal(limited.state, 'partial')
})

test('blocked, invalid, stale attempts and crash interruption remain distinct and never overwrite a sibling path', async (t) => {
  const { chains, repo, project, db } = await fixture(t)
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  db.run(
    "INSERT INTO model_configs (id,name,base_url,model_id,secret_ref,revision) VALUES ('model','test','http://127.0.0.1','fixture',NULL,1)"
  )
  const first = prepared.pathIds[0],
    second = prepared.pathIds[1]
  const result = (verdict) => ({
    verdict,
    summary: '受控上下文测试结果',
    steps: [0, 1, 2].map((stepIndex) => ({
      stepIndex,
      dangerous: verdict === 'safe' ? 0 : null,
      reason: '明确的当前路径证据',
      quotes: ['actual quote']
    }))
  })
  const evidence = [0, 1, 2].map(() => ({
    filePath: 'Repo.java',
    startLine: 1,
    endLine: 1,
    text: 'actual quote'
  }))
  const one = repo.scans.claim(project.projectId, prepared.runId, first, 'model')
  repo.scans.complete(first, one, result('safe'), evidence, false)
  const two = repo.scans.claim(project.projectId, prepared.runId, second, 'model')
  repo.scans.complete(second, two, result('invalid'), evidence, false)
  assert.equal(
    repo.detail({ projectId: project.projectId, runId: prepared.runId, pathId: first }).verdict,
    'safe'
  )
  const invalid = repo.detail({
    projectId: project.projectId,
    runId: prepared.runId,
    pathId: second
  })
  assert.equal(invalid.status, 'invalid')
  assert.equal(invalid.dangerous, null)
  assert.equal(repo.scans.statistics(project.projectId, prepared.runId).safe, 1)
  const retryRun = await chains.action('prepare', { projectId: project.projectId })
  const retryPath = retryRun.pathIds[0]
  const oldAttempt = repo.scans.claim(project.projectId, retryRun.runId, retryPath, 'model')
  repo.scans.analysisFailed(retryPath, oldAttempt, 'TEST_TIMEOUT')
  const newAttempt = repo.scans.claim(project.projectId, retryRun.runId, retryPath, 'model')
  assert.equal(newAttempt, oldAttempt + 1)
  assert.throws(() => repo.scans.complete(retryPath, oldAttempt, result('safe'), evidence, false), {
    code: 'ANALYSIS_STALE'
  })
  repo.scans.begin(project.projectId, 'crashed-scan', project.sourceStamp, 'v1')
  repo.scans.recover()
  assert.equal(
    repo.detail({ projectId: project.projectId, runId: retryRun.runId, pathId: retryPath }).status,
    'unresolved'
  )
  assert.equal(
    repo.scans.runs(project.projectId).runs.find((r) => r.runId === 'crashed-scan').errorCode,
    'SCAN_INTERRUPTED'
  )
})

test('model quotes outside actual evidence fail explicitly instead of producing a safety conclusion', async (t) => {
  const { chains, repo, query, project, db } = await fixture(t)
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  db.run(
    "INSERT INTO model_configs (id,name,base_url,model_id,secret_ref,revision) VALUES ('model','test','http://127.0.0.1','fixture',NULL,1)"
  )
  chains.analysis = new PathAnalysisService(repo, query, async (input) => ({
    verdict: 'safe',
    summary: '伪造的防护',
    steps: input.path.steps.map((s) => ({
      stepIndex: s.stepIndex,
      dangerous: 0,
      reason: 'unsupported',
      quotes: ['NOT_IN_ACTUAL_SOURCE_123456']
    }))
  }))
  const input = {
    projectId: project.projectId,
    runId: prepared.runId,
    pathId: prepared.pathIds[0],
    modelConfigId: 'model'
  }
  await chains.action('analyze', input)
  for (
    let i = 0;
    i < 100 && repo.scans.statistics(project.projectId, prepared.runId).analyzing;
    i++
  )
    await new Promise((r) => setTimeout(r, 10))
  const detail = repo.detail(input)
  assert.equal(detail.status, 'failed')
  assert.equal(detail.dangerous, null)
  assert.match(detail.summary, /ANALYSIS_EVIDENCE_INVALID/)
})
