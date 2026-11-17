import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PythonMcpManager } from '../src/service/mcp/manager.ts'
import { startHttpServer } from '../src/service/http-server.ts'
import { mcpRequest } from '../src/main/mcp-client.ts'
import {
  mcpSettingsHash,
  enabledMcpTools,
  selectedMcpServers
} from '../src/service/mcp/settings.ts'
import { createAgentHarness } from './agent-harness.mjs'
import { mcpDefinitions } from '../src/service/mcp/contracts.ts'
import { staticRules } from '../src/service/mcp/static-scanner.ts'

test('MCP import example preserves Chinese names across Windows pipe encodings', () => {
  const bytes = execFileSync(
    process.execPath,
    [
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      fileURLToPath(new URL('../scripts/mcp-import-example.mjs', import.meta.url))
    ],
    { windowsHide: true }
  )
  const expected = JSON.parse(bytes.toString('utf8'))
  assert.deepEqual(Object.keys(expected.mcpServers), ['本地计算器'])
  for (const encoding of ['utf-8', 'gbk', 'big5', 'windows-1252']) {
    assert.deepEqual(JSON.parse(new TextDecoder(encoding).decode(bytes)), expected)
  }
})

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-python-mcp-')),
    manager = new PythonMcpManager(root)
  const http = await startHttpServer('test-local-token', {
    mcpAction: (action, input, signal) => manager.action(action, input, signal)
  })
  t.after(async () => {
    await http.close()
    await manager.close()
    await rm(root, { recursive: true, force: true })
  })
  const request = async (action, input = {}) => {
    const result = await mcpRequest(http.port, 'test-local-token', action, input)
    assert.equal(result.ok, true, JSON.stringify(result))
    return result.data
  }
  return { root, manager, http, request }
}
test('Python HTTP MCP initializes/discovers both servers, persists CRUD/tool selection, and never adds a business table', async (t) => {
  const h = await fixture(t),
    hash = mcpSettingsHash(h.root)
  const contract = JSON.parse(
    await readFile(
      new URL('../../python/src/pi_audit/audit_mcp/contract.json', import.meta.url),
      'utf8'
    )
  )
  assert.deepEqual(
    contract,
    { definitions: mcpDefinitions, rules: staticRules },
    'standalone Python uses the same tool and rule contract'
  )
  const list = await h.request('list')
  assert.equal(list.total, 2)
  assert.notEqual(list.pid, process.pid)
  assert.equal(hash, mcpSettingsHash(h.root), 'initialization must not alter the semantic binding')
  const codegraph = await h.request('test', { id: 'codegraph' })
  assert.deepEqual(
    codegraph.tools.map((t) => t.name),
    ['audit_find_related', 'audit_read_related']
  )
  assert.match(codegraph.protocol, /^20\d\d-/)
  const scanner = await h.request('test', { id: 'static' })
  assert.deepEqual(
    scanner.tools.map((t) => t.name),
    ['audit_static_scan']
  )
  await h.request('configureTools', { id: 'codegraph', tools: ['audit_find_related'] })
  assert.deepEqual(enabledMcpTools(h.root), ['audit_find_related', 'audit_static_scan'])
  assert.notEqual(mcpSettingsHash(h.root), hash)
  const invalid = await mcpRequest(h.http.port, 'test-local-token', 'configureTools', {
    id: 'codegraph',
    tools: ['audit_read_related']
  })
  assert.equal(invalid.ok, false)
  assert.match(invalid.error.message, /查询/)
  await h.request('stop', { id: 'static' })
  assert.equal(enabledMcpTools(h.root).includes('audit_static_scan'), false)
  await h.request('start', { id: 'static' })
  const saved = await h.request('save', {
    name: '备用扫描器',
    kind: 'static',
    enabled: false,
    transport: 'builtin'
  })
  const custom = saved.servers.find((s) => s.name === '备用扫描器')
  await h.request('save', { ...custom, name: '备用扫描器已编辑', state: undefined })
  await h.request('delete', { id: custom.id })
  assert.equal((await h.request('list')).total, 2)
  await h.manager.close()
  assert.equal((await h.request('list')).total, 2, 'configuration survives process restart')
  const json = JSON.parse(await readFile(join(h.root, 'mcp/servers.json'), 'utf8'))
  assert.equal(json.version, 1)
  assert.equal(json.servers.length, 2)
})
test('common mcpServers imports are inert until started; actual stdio discovery/call/stop works through both HTTP layers', async (t) => {
  const h = await fixture(t),
    file = join(h.root, 'example_server.py')
  await writeFile(
    file,
    `from mcp.server.fastmcp import FastMCP\nm=FastMCP("local-fixture")\n@m.tool()\ndef add_numbers(a:int,b:int)->dict:\n    return {"sum":a+b,"apiKey":"local-test-secret"}\nif __name__=="__main__":m.run(transport="stdio")\n`
  )
  const imported = await h.request('import', {
    mcpServers: { 本地计算: { command: h.manager.runtime().pythonPath, args: ['-u', file] } }
  })
  const row = imported.servers.find((s) => s.name === '本地计算')
  assert.equal(row.enabled, false)
  assert.equal(row.state, 'disabled')
  const found = await h.request('test', { id: row.id })
  assert.equal(found.tools[0].name, 'add_numbers')
  await h.request('start', { id: row.id })
  const called = await h.request('call', {
    id: row.id,
    name: 'add_numbers',
    arguments: { a: 2, b: 3 }
  })
  assert.equal(JSON.parse(called.result.content[0].text).sum, 5)
  assert.ok(!JSON.stringify(called).includes('local-test-secret'))
  await h.request('configureTools', { id: row.id, tools: [] })
  const denied = await mcpRequest(h.http.port, 'test-local-token', 'call', {
    id: row.id,
    name: 'add_numbers',
    arguments: { a: 2, b: 3 }
  })
  assert.equal(denied.ok, false)
  await h.request('stop', { id: row.id })
  assert.equal((await h.request('list')).servers.find((s) => s.id === row.id).state, 'disabled')
  const before = (await h.request('list')).total
  const bad = await mcpRequest(h.http.port, 'test-local-token', 'import', {
    mcpServers: {
      first: { command: 'python', args: [] },
      bad: { command: 'python', env: { TOKEN: 'not-accepted' } }
    }
  })
  assert.equal(bad.ok, false)
  assert.equal(
    (await h.request('list')).total,
    before,
    'invalid import must not commit its first item'
  )
})
test('MCP manager rejects off-machine URLs, invalid runtime/input, unknown actions and unauthenticated requests', async (t) => {
  const h = await fixture(t)
  const unauthorized = await fetch(`http://127.0.0.1:${h.http.port}/mcp/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(unauthorized.status, 401)
  for (const url of [
    'https://example.com/mcp',
    'http://example.com/mcp',
    'file:///C:/x',
    'http://user:password@localhost:1234/mcp'
  ]) {
    const r = await mcpRequest(h.http.port, 'test-local-token', 'save', {
      name: 'invalid',
      kind: 'custom',
      transport: 'http',
      url
    })
    assert.equal(r.ok, false, url)
  }
  const bad = await mcpRequest(h.http.port, 'test-local-token', 'configureRuntime', {
    pythonPath: 'relative/python.exe'
  })
  assert.equal(bad.ok, false)
  const unknown = await fetch(`http://127.0.0.1:${h.http.port}/mcp/arbitrary`, {
    method: 'POST',
    headers: { Authorization: 'Bearer test-local-token', 'Content-Type': 'application/json' },
    body: '{}'
  })
  assert.equal(unknown.status, 404)
  const python = h.manager.runtime().pythonPath
  await h.request('configureRuntime', { pythonPath: join(h.root, 'missing-python.exe') })
  const failed = await mcpRequest(h.http.port, 'test-local-token', 'list', {})
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'MCP_PYTHON_MISSING')
  await h.request('configureRuntime', { pythonPath: python })
  assert.equal(
    (await h.request('list')).total,
    2,
    'fixing the interpreter preserves configurations'
  )
})
test('production agent advertises only selected MCP tools and records the Python configuration in recovery binding', async (t) => {
  const h = await createAgentHarness(t, 'finish')
  await h.query.mcp.action('configureTools', { id: 'codegraph', tools: ['audit_find_related'] })
  await h.query.mcp.action('stop', { id: 'static' })
  await h.chains.action('analyze', {
    ...h.scope,
    pathId: h.prepared.pathIds[0],
    modelConfigId: 'model'
  })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail({ ...h.scope, pathId: h.prepared.pathIds[0] }).status, 'unresolved')
  assert.deepEqual(
    h.model.requests[0].tools.map((t) => t.function.name),
    ['audit_read_step', 'audit_find_related']
  )
  const row = h.db.get(
    'SELECT binding_json FROM path_recovery WHERE path_id=?',
    h.prepared.pathIds[0]
  )
  assert.equal(JSON.parse(row.binding_json).mcpSettingsHash, mcpSettingsHash(h.query.mcp.root))
})
test('active Python contexts block runtime/config changes and DELETE releases the lease without changing audit data', async (t) => {
  const h = await fixture(t)
  await h.request('list')
  await h.manager.request('/contexts/lease-test', 'POST', {
    projectId: 'p',
    runId: 'r',
    pathId: 'path',
    snapshotId: 's',
    sourceStamp: 'stamp',
    steps: [{ edge: { filePath: 'A.java', calledFilePath: null } }],
    files: [{ filePath: 'A.java', source: 'class A {}' }],
    graph: { engine: 'basic', gaps: ['CODEGRAPH_NOT_AVAILABLE'], methods: [], calls: [] },
    servers: selectedMcpServers(h.root)
  })
  const stop = await mcpRequest(h.http.port, 'test-local-token', 'stop', { id: 'static' })
  assert.equal(stop.ok, false)
  assert.match(stop.error.message, /调查/)
  const switchProfile = await mcpRequest(h.http.port, 'test-local-token', 'save', {
    name: 'other static',
    kind: 'static',
    transport: 'builtin',
    enabled: true
  })
  assert.equal(switchProfile.ok, false)
  const restart = await mcpRequest(h.http.port, 'test-local-token', 'restartRuntime', {})
  assert.equal(restart.ok, false)
  assert.equal(restart.error.code, 'MCP_IN_USE')
  await h.manager.request('/contexts/lease-test', 'DELETE')
  await h.manager.request('/contexts/lease-test', 'DELETE')
  await h.request('stop', { id: 'static' })
  assert.equal((await h.request('list')).servers.find((s) => s.id === 'static').enabled, false)
})
