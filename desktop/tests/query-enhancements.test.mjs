import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
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
import { decodePosition, encodePosition } from '../src/service/query/positions.ts'
import { ApiError } from '../src/shared/api-error.ts'

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
      backend: 'java-codegraph',
      backendLabel: 'codegraph',
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
    backend: 'fixture-semantic',
    semantic: false,
    status: () => runtimeState,
    query: async () => {
      dispatched++
      return { items: [], gaps: [] }
    },
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
      encoded = encodePosition(source, position, encoding)
    assert.deepEqual(decodePosition(source, encoded, encoding), position)
  }
  assert.equal(encodePosition(source, { line: 1, column: 5 }, 'utf-8').character, 8)
  assert.throws(() => encodePosition(source, { line: 1, column: 4 }, 'utf-16'), {
    code: 'QUERY_INVALID_POSITION'
  })
  assert.throws(() => decodePosition(source, { line: 0, character: 5 }, 'utf-8'), {
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
test('QRY-04 removed backend is rejected and explicit basic mode stays candidate-only', async (t) => {
  const h = await fixture(t)
  assert.throws(() => new CodeQueryService(h.repo, { backend: 'jdtls' }), {
    code: 'QUERY_BACKEND_INVALID'
  })
  const q = new CodeQueryService(h.repo, { backend: 'basic' })
  t.after(() => q.close())
  const output = await q.action('query', {
    ...h.scope,
    operation: 'definition',
    filePath: 'Demo.java',
    line: 1,
    column: h.source.indexOf('to(q)') + 1
  })
  assert.equal(output.backend, 'basic')
  assert.equal(output.status, 'partial')
  assert.ok(output.items.every((i) => i.resolution === 'candidate'))
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
test('QRY-04 neutral engine timeout/unsupported/cancellation preserve statuses and explicit fallback', async (t) => {
  const h = await fixture(t),
    engine = h.query.unified.backends.get('java-codegraph')
  const request = {
    ...h.scope,
    operation: 'definition',
    filePath: 'Demo.java',
    line: 1,
    column: h.source.indexOf('to(q)') + 1
  }
  const status = {
    state: 'ready',
    index: 'unknown',
    starts: 0,
    pending: 0,
    errorCode: null,
    positionEncoding: 'utf-16',
    wholeWorkspaceIndexed: false,
    capabilities: ['definition']
  }
  for (const [code, expected] of [
    ['QUERY_TIMEOUT', 'timeout'],
    ['QUERY_CANCELLED', 'cancelled'],
    ['QUERY_UNSUPPORTED', 'unsupported']
  ]) {
    h.query.unified.backends.set('java-codegraph', {
      backend: 'codegraph',
      semantic: false,
      status: () => status,
      close: async () => {},
      query: async () => {
        throw new ApiError(code, 'fixture', 503)
      }
    })
    const failed = await h.query.action('query', { ...request, fallback: false })
    assert.equal(failed.status, expected)
    if (code !== 'QUERY_CANCELLED')
      assert.equal((await h.query.action('query', request)).backend, 'basic')
  }
  h.query.unified.backends.set('java-codegraph', engine)
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
