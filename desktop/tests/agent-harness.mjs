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
import { runAgentLoop, defaultLoopLimits } from '../src/service/chains/agent-loop.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { createAgentModelFixture } from './agent-model-fixture.mjs'
export async function createAgentHarness(t, mode = 'continue', budgets = {}, modelOptions = {}) {
  const root = modelOptions.root ?? (await mkdtemp(join(tmpdir(), 'pi-agent-'))),
    source = join(root, 'source')
  await mkdir(root, { recursive: true })
  await mkdir(source)
  await writeFile(
    join(source, 'Demo.java'),
    'class Demo { Statement stmt; @GetMapping("/a") void a(String q){ query(q); } @GetMapping("/b") void b(String q){ query(q); } void query(String q){ ' +
      (mode === 'safe'
        ? 'if(!q.matches("[a-zA-Z0-9_]+")) throw new IllegalArgumentException(); '
        : '') +
      'stmt.executeQuery("SELECT "+q); } }'
  )
  const db = openStorage(join(root, 'runtime')),
    sources = new SourceRepository(db)
  const project = await importLocal(sources, { projectName: 'agent learning', path: source })
  const query = new CodeQueryService(sources),
    repo = new CallChainRepository(db),
    chains = new CallChainService(repo, query)
  const model = await createAgentModelFixture({ mode, ...modelOptions }),
    runtime = new PiRuntime(join(root, 'pi'))
  db.run(
    "INSERT INTO model_configs (id,name,base_url,model_id,secret_ref,revision) VALUES ('model','offline',?,'fixture','fake-ref',1)",
    model.baseUrl
  )
  const ports = {
    getConfig: async (id) =>
      id === 'model'
        ? {
            id: 'model',
            revision: 1,
            name: 'offline',
            baseUrl: model.baseUrl,
            modelId: 'fixture',
            secretRef: 'fake-ref',
            api: 'openai-completions'
          }
        : undefined,
    readSecret: async () => 'local-fixture-key'
  }
  chains.analysis = new PathAnalysisService(
    repo,
    query,
    (input, signal) =>
      runAgentLoop(runtime, ports, input, signal, { ...defaultLoopLimits, ...budgets }),
    true
  )
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  const scope = { projectId: project.projectId, runId: prepared.runId }
  // 此 fixture 明确模拟用户确认；未确认拒绝行为由 input-enhancements.test 覆盖。
  const disclosure = await chains.action('disclosure', { ...scope, modelConfigId: 'model' })
  await chains.action('authorize', {
    ...scope,
    modelConfigId: 'model',
    scopeKey: disclosure.scopeKey
  })
  t.after(async () => {
    await chains.close()
    await runtime.close()
    await query.close()
    await model.close()
    db.close()
    if (!modelOptions.keepFiles) await rm(root, { recursive: true, force: true })
  })
  return { root, source, db, repo, query, chains, model, runtime, scope, prepared, ports }
}
export async function waitDone(repo, scope) {
  const end = Date.now() + 15000
  while (repo.scans.statistics(scope.projectId, scope.runId).analyzing) {
    if (Date.now() > end) throw Error('agent fixture timeout')
    await new Promise((r) => setTimeout(r, 20))
  }
  // allow serial queue to claim the next item
  await new Promise((r) => setTimeout(r, 40))
}
