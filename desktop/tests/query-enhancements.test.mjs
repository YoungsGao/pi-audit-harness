import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { openStorage } from '../src/service/storage/schema.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { importLocal } from '../src/service/sources/local.ts'
import { CodeQueryService } from '../src/service/query/service.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { CallChainService } from '../src/service/chains/service.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { queryOnce } from '../scripts/query-cli.mjs'
import { validateQuery } from '../src/service/query/unified-service.ts'
import { LanguageRegistry } from '../src/service/query/language-registry.ts'
import { fromLspPosition, toLspPosition } from '../src/service/query/positions.ts'
import { LspRpc } from '../src/service/query/lsp-rpc.ts'
import { semanticJava } from '../src/service/query/semantic-java.ts'
import { ApiError } from '../src/shared/api-error.ts'
import { JavaRuntimePool, waitFor } from '../src/service/query/java-runtime.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-query-enhanced-')),
    path = join(root, 'source')
  await mkdir(path)
  const source =
    'class Demo { void from(String q) { to(q); } void to(String q) { stmt.executeQuery(q); } }'
  await writeFile(join(path, 'Demo.java'), source)
  const db = openStorage(join(root, 'runtime')),
    repo = new SourceRepository(db),
    project = await importLocal(repo, { projectName: 'query contract fixture', path })
  const query = new CodeQueryService(repo),
    chains = new CallChainService(new CallChainRepository(db), query)
  const prepared = await chains.action('prepare', { projectId: project.projectId })
  const scope = { language: 'java', projectId: project.projectId, runId: prepared.runId }
  t.after(async () => {
    await chains.close()
    await query.close()
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  return { root, path, source, db, repo, query, chains, scope, project, prepared }
}
test('QRY-02/05 strict contract: per-operation fields, UTF positions and language negotiation', async (t) => {
  const h = await fixture(t)
  const input = { ...h.scope, operation: 'definition', filePath: 'Demo.java', line: 1, column: 1 }
  for (const extra of [
    { command: 'x' },
    { uri: 'file:///outside' },
    { server: 'java' },
    { direction: 'incoming' }
  ])
    assert.throws(() => validateQuery({ ...input, ...extra }), { code: 'QUERY_INVALID_INPUT' })
  for (const filePath of ['../x.java', '/x.java', 'C:/x.java', 'a\\x.java', 'x\0.java'])
    assert.throws(() => validateQuery({ ...input, filePath }), { code: 'QUERY_INVALID_INPUT' })
  assert.throws(() => validateQuery({ ...input, line: 0 }), { code: 'QUERY_INVALID_INPUT' })
  assert.throws(() => validateQuery({ ...input, maxResults: 101 }), { code: 'QUERY_INVALID_INPUT' })
  const unsupported = await h.query.action('query', {
    ...h.scope,
    operation: 'capabilities',
    language: 'python'
  })
  assert.equal(unsupported.status, 'unsupported')
  assert.equal(unsupported.backend, 'none')
  const catalog = await h.query.action('query', { ...h.scope, operation: 'capabilities' })
  assert.deepEqual(
    catalog.capabilities.map((a) => a.language),
    ['java']
  )
  assert.equal(catalog.runtime.starts, 0)
  assert.equal(catalog.runtime.wholeWorkspaceIndexed, false)
  const registry = new LanguageRegistry(),
    adapter = {
      language: 'java',
      backend: 'java-jdtls',
      backendLabel: 'jdtls',
      query: async () => ({ items: [], gaps: [] }),
      extensions: ['.java'],
      encodings: ['utf-16'],
      operations: ['symbols']
    }
  registry.register(adapter)
  assert.throws(() => registry.register(adapter))
  assert.equal(registry.get('python'), undefined)
  // 测试专用提供商证明业务按语言/后端分派；生产默认仍只有 Java。
  let dispatched = 0
  h.query.unified.languages.register({
    ...adapter,
    language: 'fixture-language',
    backend: 'fixture-provider',
    backendLabel: 'fixture-semantic',
    operations: ['definition'],
    query: async () => {
      dispatched++
      return { items: [], gaps: [] }
    }
  })
  const runtimeState = { ...catalog.runtime, state: 'ready', capabilities: ['definition'] }
  h.query.unified.backends.set('fixture-provider', {
    get: () => ({ status: () => runtimeState, use: async (fn) => fn({ state: runtimeState }) }),
    close: async () => {}
  })
  const routed = await h.query.action('query', { ...input, language: 'fixture-language' })
  assert.equal(routed.backend, 'fixture-semantic')
  assert.equal(routed.status, 'no-match')
  assert.equal(dispatched, 1)
  const unsupportedOperation = await h.query.action('query', {
    ...h.scope,
    filePath: 'Demo.java',
    language: 'fixture-language',
    operation: 'symbols'
  })
  assert.equal(unsupportedOperation.status, 'unsupported')
  const source = 'a中😀z\r\nnext'
  for (const encoding of ['utf-8', 'utf-16', 'utf-32']) {
    const position = { line: 1, column: 5 },
      lsp = toLspPosition(source, position, encoding)
    assert.deepEqual(fromLspPosition(source, lsp, encoding), position)
  }
  assert.equal(toLspPosition(source, { line: 1, column: 5 }, 'utf-8').character, 8)
  assert.throws(() => toLspPosition(source, { line: 1, column: 4 }, 'utf-16'), {
    code: 'QUERY_INVALID_POSITION'
  })
  assert.throws(() => fromLspPosition(source, { line: 0, character: 5 }, 'utf-8'), {
    code: 'QUERY_BACKEND_OUTPUT'
  })
})
test('QRY-02 reads/searches are snapshot-bound; no-match, truncation, cancelled and scope failures stay distinct', async (t) => {
  const h = await fixture(t)
  await writeFile(join(h.path, 'Demo.java'), 'class Later {}')
  const read = await h.query.action('query', {
    ...h.scope,
    operation: 'read',
    filePath: 'Demo.java',
    line: 1,
    endLine: 1
  })
  assert.equal(read.items[0].text, h.source)
  assert.equal(read.backend, 'basic')
  const empty = await h.query.action('query', {
    ...h.scope,
    operation: 'search',
    text: 'no-match-9874'
  })
  assert.equal(empty.status, 'no-match')
  assert.deepEqual(empty.items, [])
  const bounded = await h.query.action('query', {
    ...h.scope,
    operation: 'search',
    text: 'q',
    maxResults: 1
  })
  assert.equal(bounded.status, 'partial')
  assert.equal(bounded.items.length, 1)
  assert.equal(bounded.truncated, true)
  await assert.rejects(
    h.query.action('query', { ...h.scope, operation: 'symbols', filePath: 'Outside.java' }),
    { code: 'QUERY_FILE_OUT_OF_SCOPE' }
  )
  await assert.rejects(
    h.query.action('query', { ...h.scope, runId: 'other-task', operation: 'status' }),
    { code: 'SNAPSHOT_MISSING' }
  )
  await assert.rejects(
    h.query.action('query', {
      ...h.scope,
      operation: 'read',
      filePath: 'Demo.java',
      line: 1,
      endLine: 81
    }),
    { code: 'QUERY_INVALID_INPUT' }
  )
  const cancelled = await h.query.unified.execute(
    { ...h.scope, operation: 'status' },
    AbortSignal.abort()
  )
  assert.equal(cancelled.status, 'cancelled')
})
test('QRY-04 missing runtime falls back to candidates with coverage gaps; original failure remains observable', async (t) => {
  const h = await fixture(t)
  const query = new CodeQueryService(h.repo, {
    dataRoot: join(h.root, 'missing-runtime'),
    javaHome: join(h.root, 'no-java'),
    jdtlsHome: join(h.root, 'no-jdt')
  })
  t.after(() => query.close())
  const request = {
    ...h.scope,
    operation: 'definition',
    filePath: 'Demo.java',
    line: 1,
    column: h.source.indexOf('to(q)') + 1
  }
  const missing = await query.action('query', { ...request, fallback: false })
  assert.equal(missing.status, 'not-ready')
  assert.equal(missing.errorCode, 'QUERY_RUNTIME_MISSING')
  const fallback = await query.action('query', request)
  assert.equal(fallback.status, 'partial')
  assert.equal(fallback.backend, 'basic')
  assert.ok(fallback.gaps.includes('BASIC_CANDIDATES_NOT_SEMANTIC'))
  assert.ok(fallback.items.every((i) => i.resolution === 'candidate'))
  assert.ok(fallback.items[0].symbol.signature.includes('String'))
  const outgoing = await query.action('query', {
    ...request,
    operation: 'outgoingCalls',
    column: h.source.indexOf('void to') + 6
  })
  assert.equal(outgoing.items.length, 0) // 同一行上的第二个方法不能误选第一个方法。
  assert.ok(outgoing.gaps.includes('CALL_TARGET_UNRESOLVED'))
  const status = await query.action('query', { ...h.scope, operation: 'status' })
  assert.equal(status.runtime.starts, 0)
  assert.equal(status.runtime.state, 'failed')
})
test('QRY-02 real authenticated HTTP and separate CLI process share the same contract and reject arbitrary routing', async (t) => {
  const h = await fixture(t),
    token = 'query-test-token-'.repeat(3)
  const server = await startHttpServer(token, { codeQuery: (a, v, s) => h.query.action(a, v, s) })
  t.after(() => server.close())
  const input = { ...h.scope, operation: 'search', text: 'to' }
  const output = await queryOnce(input, { port: server.port, token })
  assert.equal(output.contractVersion, 1)
  assert.equal(
    output.snapshotId,
    h.query.snapshots.info(h.scope.projectId, h.scope.runId).snapshotId
  )
  assert.equal(
    (await fetch(`http://127.0.0.1:${server.port}/code/query`, { method: 'POST' })).status,
    401
  )
  await assert.rejects(
    queryOnce(input, { port: server.port, token: 'wrong-token-but-more-than-thirty-two' }),
    /UNAUTHORIZED/
  )
  const child = spawn(process.execPath, ['scripts/query-cli.mjs'], {
    cwd: join(import.meta.dirname, '..'),
    windowsHide: true,
    env: { ...process.env, PI_AUDIT_QUERY_PORT: String(server.port), PI_AUDIT_QUERY_TOKEN: token },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let stdout = '',
    stderr = ''
  child.stdout.on('data', (b) => (stdout += b))
  child.stderr.on('data', (b) => (stderr += b))
  child.stdin.end(JSON.stringify(input))
  const code = await new Promise((resolve) => child.once('close', resolve))
  assert.equal(code, 0, stderr)
  assert.equal(JSON.parse(stdout).sourceStamp, output.sourceStamp)
  assert.ok(!stdout.includes(token))
  await assert.rejects(
    queryOnce(input, { port: 'http://example.com', token }),
    /QUERY_CLI_CONNECTION/
  )
})
function rpcFixture(t) {
  const rpc = new LspRpc(
    process.execPath,
    [join(import.meta.dirname, 'fixtures', 'query-lsp-fixture.mjs')],
    tmpdir(),
    process.env
  )
  t.after(() => rpc.close())
  return rpc
}
test('QRY-04 stdio framing handles fragmented UTF-8 and client requests; unsupported, timeout and cancellation do not poison later requests', async (t) => {
  const rpc = rpcFixture(t)
  rpc.onServerRequest = (method) =>
    method === 'workspace/applyEdit' ? { applied: false } : undefined
  assert.equal(await rpc.request('client-request', {}, 1000), '问😀')
  await assert.rejects(rpc.request('unsupported', {}, 1000), { code: 'QUERY_UNSUPPORTED' })
  await assert.rejects(rpc.request('slow', {}, 20), { code: 'QUERY_TIMEOUT' })
  const controller = new AbortController(),
    pending = rpc.request('slow', {}, 1000, controller.signal)
  controller.abort()
  await assert.rejects(pending, { code: 'QUERY_CANCELLED' })
  await new Promise((r) => setTimeout(r, 160))
  assert.deepEqual(await rpc.request('echo', { newRequest: true }, 1000), { newRequest: true })
  assert.equal(rpc.pendingCount, 0)
})
test('QRY-04 crashed and malformed peers settle all requests and stop accepting work', async (t) => {
  const crash = rpcFixture(t)
  await assert.rejects(crash.request('crash', {}, 1000), { code: 'QUERY_RUNTIME_EXITED' })
  const malformed = rpcFixture(t)
  await assert.rejects(malformed.request('malformed', {}, 1000), { code: 'QUERY_PROTOCOL_ERROR' })
  assert.equal(crash.pendingCount, 0)
  assert.equal(malformed.pendingCount, 0)
})
test('QRY-03/05 semantic location adapters preserve signatures, filter external URIs and negotiate hierarchy without guessing', async () => {
  const source = 'package demo; class A { void x() {} }',
    filePath = 'demo/A.java',
    root = join(tmpdir(), 'query-adapter-root'),
    uri = pathToFileURL(join(root, filePath)).href
  const range = { start: { line: 0, character: 23 }, end: { line: 0, character: 34 } },
    selectionRange = { start: { line: 0, character: 28 }, end: { line: 0, character: 29 } }
  const responses = {
    'textDocument/definition': [
      { targetUri: uri, targetSelectionRange: selectionRange },
      { uri: 'jdt://external/Library.class', range }
    ],
    'textDocument/documentSymbol': [
      {
        name: 'A',
        kind: 5,
        range: { start: { line: 0, character: 14 }, end: { line: 0, character: 36 } },
        selectionRange: { start: { line: 0, character: 20 }, end: { line: 0, character: 21 } },
        children: [{ name: 'x()', detail: ' : void', kind: 6, range, selectionRange }]
      }
    ]
  }
  const runtime = {
    root,
    sourceGaps: [],
    snapshot: { files: [{ filePath, source }] },
    state: { positionEncoding: 'utf-16', capabilities: ['symbols', 'definition'] },
    request: async (method) => responses[method]
  }
  const result = await semanticJava(
    runtime,
    { operation: 'definition', filePath, line: 1, column: 29 },
    new AbortController().signal
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].symbol.qualifiedName, 'demo.A.x()')
  assert.equal(result.items[0].symbol.signature, 'x() : void')
  assert.ok(result.gaps.includes('EXTERNAL_LOCATION_OMITTED'))
})
test('QRY-04 timeout/unsupported are preserved when fallback is disabled and become partial candidates when enabled', async (t) => {
  const h = await fixture(t)
  const request = {
    ...h.scope,
    operation: 'definition',
    filePath: 'Demo.java',
    line: 1,
    column: h.source.indexOf('to(q)') + 1
  }
  const original = h.query.unified.pool.get.bind(h.query.unified.pool)
  h.query.unified.pool.get = () => ({
    status: () => ({ state: 'ready', starts: 1, capabilities: ['definition'] }),
    use: async () => {
      throw new ApiError('QUERY_TIMEOUT', 'timeout', 504)
    }
  })
  assert.equal((await h.query.action('query', { ...request, fallback: false })).status, 'timeout')
  assert.equal((await h.query.action('query', request)).status, 'partial')
  h.query.unified.pool.get = () => ({
    status: () => ({ state: 'ready', starts: 1, capabilities: [] }),
    use: async (fn) => fn({ state: { capabilities: [] } })
  })
  assert.equal(
    (await h.query.action('query', { ...request, fallback: false })).status,
    'unsupported'
  )
  h.query.unified.pool.get = original
})
test('QRY-04 project/language/snapshot pool is bounded, reuses run-equivalent content, and cancellation only detaches its waiter', async (t) => {
  const pool = new JavaRuntimePool({ idleMs: 25 })
  t.after(() => pool.close())
  const snapshot = {
    projectId: 'p1',
    runId: 'r1',
    sourceStamp: 's1',
    snapshotId: 'snap1',
    files: []
  }
  const one = pool.get(snapshot)
  assert.equal(pool.get({ ...snapshot, runId: 'r2' }), one)
  assert.notEqual(pool.get({ ...snapshot, projectId: 'p2' }), one)
  assert.throws(() => pool.get({ ...snapshot, sourceStamp: 's2' }), { code: 'QUERY_RUNTIME_BUSY' })
  let resolve
  const shared = new Promise((r) => (resolve = r)),
    controller = new AbortController()
  const cancelled = waitFor(shared, controller.signal),
    other = waitFor(shared, new AbortController().signal)
  controller.abort()
  await assert.rejects(cancelled, { code: 'QUERY_CANCELLED' })
  resolve('ready')
  assert.equal(await other, 'ready')
  const deadline = Date.now() + 1000
  while (pool.sessions.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20))
  assert.equal(pool.sessions.size, 0)
  assert.notEqual(pool.get(snapshot), one)
  await pool.close()
  assert.throws(() => pool.get(snapshot), { code: 'QUERY_CANCELLED' })
})
test('QRY-02 standalone CLI supervisor opens existing snapshots, serves multiple clients, and exits gracefully', async (t) => {
  const h = await fixture(t),
    token = 'standalone-supervisor-token-'.repeat(2)
  const child = spawn(
    process.execPath,
    ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', 'scripts/query-service.mjs'],
    {
      cwd: join(import.meta.dirname, '..'),
      windowsHide: true,
      env: {
        ...process.env,
        PI_AUDIT_DATA_ROOT: join(h.root, 'runtime'),
        PI_AUDIT_QUERY_TOKEN: token
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  const closed = new Promise((resolve) => child.once('close', resolve))
  t.after(async () => {
    if (child.exitCode === null) {
      child.stdin.write('shutdown\n')
      await closed
    }
  })
  let stdout = '',
    stderr = ''
  child.stderr.on('data', (b) => (stderr += b))
  const ready = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill()
      reject(Error('supervisor timeout ' + stderr))
    }, 5000)
    child.once('error', reject)
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      if (stdout.includes('\n')) {
        clearTimeout(timeout)
        resolve(JSON.parse(stdout.split('\n')[0]))
      }
    })
  })
  assert.equal(ready.state, 'ready', stderr)
  const request = { ...h.scope, operation: 'read', filePath: 'Demo.java', line: 1, endLine: 1 }
  assert.equal((await queryOnce(request, { port: ready.port, token })).items[0].text, h.source)
  assert.equal(
    (await queryOnce({ ...h.scope, operation: 'status' }, { port: ready.port, token })).runtime
      .starts,
    0
  )
  assert.ok(!stdout.includes(token))
  child.stdin.write('shutdown\n')
  assert.equal(await closed, 0, stderr)
})
