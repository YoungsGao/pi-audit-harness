import assert from 'node:assert/strict'
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ServiceManager } from '../src/main/service-manager'
import type { SourceProject } from '../src/shared/source-contracts'
import type { RuleCatalog } from '../src/shared/code-query-contracts'
import type { GraphSaved } from '../src/shared/call-chain-contracts'

const root = resolve('.chains-test-data', randomUUID())
app.setPath('userData', join(root, 'profile'))
const service = new ServiceManager(
  () => {},
  () => join(root, 'runtime')
)
function internals(): { child: { pid: number }; connection: { port: number; token: string } } {
  return service as unknown as ReturnType<typeof internals>
}
async function request<T>(path: string, input?: unknown): Promise<T> {
  const { port, token } = internals().connection
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: input ? 'POST' : 'GET',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    ...(input ? { body: JSON.stringify(input) } : {})
  })
  assert.equal(response.status, 200)
  const body = (await response.json()) as { ok: boolean; data: T }
  assert.equal(body.ok, true)
  return body.data
}
void app.whenReady().then(async () => {
  try {
    const path = join(root, 'java-source')
    mkdirSync(path, { recursive: true })
    writeFileSync(
      join(path, 'Demo.java'),
      [
        'class Demo {',
        '  void search(String input) throws Exception {',
        '    stmt.executeQuery("SELECT * FROM users WHERE name=" + input);',
        '    Runtime.getRuntime().exec(input);',
        '    Files.readString(path);',
        '  }',
        '}'
      ].join('\n')
    )
    await service.start()
    assert.equal(service.getStatus().database?.schemaVersion, 12)
    const firstPid = internals().child.pid
    const project = await request<SourceProject>('/sources/local', {
      projectName: 'TPL-QRY-DB03 Electron sample',
      path
    })
    const catalog = await request<RuleCatalog>('/rules')
    assert.equal(catalog.rules.length, 5)
    const found = await request<{ matches: unknown[] }>('/code/search', {
      projectId: project.projectId,
      text: 'executeQuery'
    })
    assert.equal(found.matches.length, 1)
    const prepared = await request<GraphSaved & { candidateCount: number; scope: string }>(
      '/chains/prepare',
      { projectId: project.projectId }
    )
    assert.equal(prepared.candidateCount, 3)
    assert.equal(prepared.scope, 'bounded-java-call-paths')
    const detailInput = {
      projectId: project.projectId,
      runId: prepared.runId,
      pathId: prepared.pathIds[0]
    }
    const detail = await request<{
      status: string
      dangerous: null
      steps: { edge: { resolutionStatus: string } }[]
    }>('/chains/detail', detailInput)
    assert.equal(detail.status, 'pending')
    assert.equal(detail.dangerous, null)
    assert.equal(detail.steps[0].edge.resolutionStatus, 'candidate')
    await service.stop()
    await service.start()
    assert.notEqual(internals().child.pid, firstPid)
    assert.deepEqual(await request('/chains/detail', detailInput), detail)
    const listed = await request<{ total: number; rulesVersion: string }>('/chains/list', {
      projectId: project.projectId,
      runId: prepared.runId
    })
    assert.equal(listed.total, 3)
    assert.equal(listed.rulesVersion, catalog.version)
    await service.stop()
    console.info(
      'PASS TPL-01/QRY-01/DB-03: production utilityProcess, real rg, three-category rules, SQLite rows, different-PID restart; no model calls.'
    )
    console.info('SAMPLE DATABASE=', join(root, 'runtime/storage/audit.sqlite3'))
    console.info('SAMPLE PROJECT=', project.projectId, 'RUN=', prepared.runId)
    app.exit(0)
  } catch (error) {
    console.error(error)
    await service.stop().catch(() => {})
    app.exit(1)
  }
})
