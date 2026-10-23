import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { builtinRules } from '../src/service/rules/builtin.ts'
import { startHttpServer } from '../src/service/http-server.ts'

test('actual source -> authenticated query -> necessary candidate edges/path steps -> SQLite -> reopen; no model or fabricated call graph', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-chains-http-')),
    path = join(root, 'source'),
    runtime = join(root, 'runtime')
  await mkdir(path)
  await writeFile(
    join(path, 'Demo.java'),
    'class Demo { void run(String user) throws Exception { Runtime.getRuntime().exec(user); } }'
  )
  let db = openStorage(runtime)
  const sourceRepo = new SourceRepository(db),
    project = await importLocal(sourceRepo, { projectName: 'real Java fixture', path })
  const query = new CodeQueryService(sourceRepo),
    chains = new CallChainService(new CallChainRepository(db), query)
  const server = await startHttpServer('local-rules-token', {
    getRules: () => builtinRules,
    codeQuery: (a, v, s) => query.action(a, v, s),
    chainAction: (a, v, s) => chains.action(a, v, s)
  })
  t.after(async () => {
    await server.close()
    await chains.close()
    await query.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  const request = async (url, body) => {
    const result = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer local-rules-token', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {})
    })
    return { status: result.status, body: await result.json() }
  }
  assert.equal((await fetch(`http://127.0.0.1:${server.port}/rules`)).status, 401)
  assert.equal((await request('/rules')).body.data.version, builtinRules.version)
  const read = await request('/code/read', {
    projectId: project.projectId,
    filePath: 'Demo.java',
    startLine: 1,
    endLine: 1
  })
  assert.equal(read.status, 200)
  const prepared = await request('/chains/prepare', { projectId: project.projectId })
  assert.equal(prepared.status, 200)
  assert.equal(prepared.body.data.scope, 'bounded-java-call-paths')
  assert.equal(prepared.body.data.candidateCount, 1)
  const { runId, pathIds } = prepared.body.data
  const listed = await request('/chains/list', { projectId: project.projectId, runId })
  assert.equal(listed.body.data.total, 1)
  const detailInput = { projectId: project.projectId, runId, pathId: pathIds[0] }
  const detail = (await request('/chains/detail', detailInput)).body.data
  assert.equal(detail.status, 'pending')
  assert.equal(detail.dangerous, null)
  assert.equal(detail.truncationReason, 'unresolved-caller')
  assert.equal(detail.steps[0].edge.resolutionStatus, 'candidate')
  assert.equal(detail.steps[0].edge.arguments[0].text, 'user')
  await writeFile(
    join(path, 'Demo.java'),
    'class Demo { void run(String user) throws Exception { Runtime.getRuntime().exec(user); Files.readString(path); } }'
  )
  const boundedProject = await importLocal(sourceRepo, {
    projectName: 'bounded fixture',
    path,
    duplicate: 'new'
  })
  assert.equal(
    (await request('/code/search', { projectId: project.projectId, text: 'run', shell: true }))
      .status,
    400
  )
  assert.equal(
    (await request('/chains/prepare', { projectId: project.projectId, edges: [] })).status,
    400
  )
  assert.equal((await request('/chains/list', { projectId: 'other', runId })).status, 404)
  const bounded = (
    await request('/chains/prepare', { projectId: boundedProject.projectId, maxResults: 1 })
  ).body.data
  assert.equal(bounded.candidateCount, 1)
  const boundedDetail = (
    await request('/chains/detail', {
      projectId: boundedProject.projectId,
      runId: bounded.runId,
      pathId: bounded.pathIds[0]
    })
  ).body.data
  assert.equal(boundedDetail.truncationReason, 'candidate-limit')
  const large = await fetch(`http://127.0.0.1:${server.port}/code/read`, {
    method: 'POST',
    headers: { Authorization: 'Bearer local-rules-token', 'Content-Type': 'application/json' },
    body: 'x'.repeat(17000)
  })
  assert.equal(large.status, 413)
  await server.close()
  await chains.close()
  await query.close()
  db.close()
  db = openStorage(runtime)
  assert.deepEqual(new CallChainRepository(db).detail(detailInput), detail)
})
