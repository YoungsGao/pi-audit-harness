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
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { runAgentLoop, defaultLoopLimits } from '../src/service/chains/agent-loop.ts'
import { createAgentModelFixture } from './agent-model-fixture.mjs'

test(
  'real JDT-LS: cross-file overload definition participates in persisted risk path; reuses process and frozen snapshot',
  { skip: !process.env.PI_AUDIT_TEST_JDTLS, timeout: 180000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-jdt-real-'))
    const path = join(root, 'source')
    await mkdir(path)
    const sources = {
      'src/main/java/demo/Web.java':
        'package demo; class Web { Service service; @GetMapping("/q") String query(String input) throws Exception { return service.search(input); } } @interface GetMapping { String value(); }',
      'src/main/java/demo/Service.java':
        'package demo; class Service { Repo repo; String search(String input) throws Exception { return repo.query(input); } String search(int input) { return "number"; } }',
      'src/main/java/demo/Repo.java':
        'package demo; import java.sql.Statement; class Repo { Statement stmt; String query(String input) throws Exception { stmt.executeQuery("SELECT x="+input); return input; } }'
    }
    await mkdir(join(path, 'src/main/java/demo'), { recursive: true })
    for (const [name, source] of Object.entries(sources)) await writeFile(join(path, name), source)
    // 这些脚本不进入运行时快照，也不被执行。
    await writeFile(join(path, 'build.gradle'), 'throw new RuntimeException("MUST_NOT_EXECUTE")')
    const db = openStorage(join(root, 'runtime')),
      sourceRepo = new SourceRepository(db)
    const project = await importLocal(sourceRepo, {
      projectName: 'real Java semantic fixture',
      path
    })
    const query = new CodeQueryService(sourceRepo, {
      dataRoot: join(root, 'runtime'),
      javaHome: process.env.PI_AUDIT_JAVA_HOME,
      jdtlsHome: process.env.PI_AUDIT_JDTLS_HOME
    })
    const repo = new CallChainRepository(db),
      chains = new CallChainService(repo, query)
    const model = await createAgentModelFixture({ mode: 'batch' }),
      pi = new PiRuntime(join(root, 'pi'))
    t.after(async () => {
      await chains.close()
      await pi.close()
      await model.close()
      await query.close()
      db.close()
      await rm(root, { recursive: true, force: true })
    })
    const prepared = await chains.action('prepare', { projectId: project.projectId })
    const details = prepared.pathIds.map((pathId) =>
      repo.detail({ projectId: project.projectId, runId: prepared.runId, pathId })
    )
    assert.ok(details.length > 0)
    assert.ok(
      details.some((d) =>
        d.steps.some(
          (s) =>
            s.edge.resolutionStatus === 'confirmed' &&
            s.edge.calledFilePath === 'src/main/java/demo/Service.java'
        )
      ),
      JSON.stringify({ prepared, details })
    )
    const scope = {
      projectId: project.projectId,
      runId: prepared.runId,
      language: 'java',
      fallback: false
    }
    const source = sources['src/main/java/demo/Web.java'],
      column = source.indexOf('search(input)') + 1
    const definition = await query.action('query', {
      ...scope,
      operation: 'definition',
      filePath: 'src/main/java/demo/Web.java',
      line: 1,
      column
    })
    assert.equal(definition.backend, 'jdtls')
    assert.equal(definition.items.length, 1, JSON.stringify(definition))
    assert.equal(definition.items[0].location.filePath, 'src/main/java/demo/Service.java')
    assert.match(definition.items[0].symbol.qualifiedName, /demo.Service.search/)
    assert.match(definition.items[0].symbol.name, /String/)
    assert.equal(definition.runtime.starts, 1)
    assert.equal(definition.runtime.wholeWorkspaceIndexed, false)
    await writeFile(join(path, 'src/main/java/demo/Service.java'), 'class Changed {}')
    const again = await query.action('query', {
      ...scope,
      operation: 'definition',
      filePath: 'src/main/java/demo/Web.java',
      line: 1,
      column
    })
    assert.deepEqual(again.items, definition.items)
    const symbols = await query.action('query', {
      ...scope,
      operation: 'symbols',
      filePath: 'src/main/java/demo/Service.java'
    })
    assert.ok(symbols.items.some((i) => i.symbol.name.includes('search(int)')))
    const refs = await query.action('query', {
      ...scope,
      operation: 'references',
      filePath: 'src/main/java/demo/Service.java',
      line: 1,
      column: sources['src/main/java/demo/Service.java'].indexOf('search(String') + 1
    })
    assert.ok(
      refs.items.some((i) => i.location.filePath === 'src/main/java/demo/Web.java'),
      JSON.stringify(refs)
    )
    const calls = await query.action('query', {
      ...scope,
      operation: 'incomingCalls',
      filePath: 'src/main/java/demo/Service.java',
      line: 1,
      column: sources['src/main/java/demo/Service.java'].indexOf('search(String') + 1
    })
    if (calls.runtime.capabilities.includes('incomingCalls'))
      assert.ok(
        calls.items.some((i) => i.callSite.filePath === 'src/main/java/demo/Web.java'),
        JSON.stringify(calls)
      )
    else assert.equal(calls.status, 'unsupported')
    const outgoing = await query.action('query', {
      ...scope,
      operation: 'outgoingCalls',
      filePath: 'src/main/java/demo/Web.java',
      line: 1,
      column: sources['src/main/java/demo/Web.java'].indexOf('query(String') + 1
    })
    if (outgoing.runtime.capabilities.includes('outgoingCalls'))
      assert.ok(
        outgoing.items.some((i) => i.symbol.qualifiedName.includes('demo.Service.search')),
        JSON.stringify(outgoing)
      )
    db.run(
      "INSERT INTO model_configs(id,name,base_url,model_id,secret_ref,revision) VALUES('model','offline',?,'fixture','fake-ref',1)",
      model.baseUrl
    )
    const ports = {
      getConfig: async () => ({
        id: 'model',
        revision: 1,
        name: 'offline',
        baseUrl: model.baseUrl,
        modelId: 'fixture',
        secretRef: 'fake-ref',
        api: 'openai-completions'
      }),
      readSecret: async () => 'local-fixture-key'
    }
    chains.analysis = new PathAnalysisService(
      repo,
      query,
      (input, signal) => runAgentLoop(pi, ports, input, signal, defaultLoopLimits),
      true
    )
    const analysisScope = {
      projectId: project.projectId,
      runId: prepared.runId,
      modelConfigId: 'model'
    }
    const disclosure = await chains.action('disclosure', analysisScope)
    await chains.action('authorize', { ...analysisScope, scopeKey: disclosure.scopeKey })
    await chains.action('analyze', { ...analysisScope, pathId: prepared.pathIds[0] })
    await chains.analysis.waitForIdle()
    const analyzed = repo.detail({ ...analysisScope, pathId: prepared.pathIds[0] })
    assert.notEqual(analyzed.status, 'failed', analyzed.summary)
    assert.ok(
      analyzed.steps.every((step) => step.evidence.length > 0),
      JSON.stringify(analyzed)
    )
    assert.ok(JSON.stringify(model.requests).includes('confirmed'))
    console.log(
      'REAL_JDTLS_EVIDENCE',
      JSON.stringify({
        snapshotId: definition.snapshotId,
        definition: definition.items[0].symbol,
        starts: again.runtime.starts,
        confirmed: details
          .flatMap((d) => d.steps)
          .filter((s) => s.edge.resolutionStatus === 'confirmed').length,
        gaps: definition.gaps,
        calls: calls.items.length,
        agentRequests: model.requests.length,
        verdict: analyzed.verdict
      })
    )
  }
)
