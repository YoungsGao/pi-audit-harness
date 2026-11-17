import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createLab, openLab, runDemo } from '../scripts/mcp-lab.mjs'
import { mcpArgs, mcpHash, MCP_PROFILE } from '../src/service/mcp/contracts.ts'
import { scanStatic, SEMGREP_VERSION } from '../src/service/mcp/static-scanner.ts'
import {
  resolveResultCitations,
  combinedEvidence
} from '../src/service/chains/evidence-citations.ts'
import { validateResult } from '../src/service/chains/path-analysis.ts'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { migrations, migrate } from '../src/service/storage/schema.ts'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-test-')),
    lab = await createLab(root),
    h = await openLab(lab.labFile)
  t.after(async () => {
    await h.close()
    await rm(root, { recursive: true, force: true })
  })
  return h
}
test('MCP real initialize/list/call finds one-hop helper and reads only granted frozen source with verifiable citations', async (t) => {
  const h = await fixture(t),
    demo = await runDemo(h)
  assert.equal(demo.read.ranges[0].filePath, 'Helper.java')
  assert.ok(demo.read.ranges[0].text.includes('return input;'))
  assert.ok(demo.read.citations.length)
  assert.equal(demo.query.items[0].classification, 'graph-candidate')
  const receipt = {
    name: demo.read.tool,
    args: {
      stepIndex: demo.read.stepIndex,
      targetId: demo.query.items.find((r) => r.item.location.filePath === 'Helper.java').targetId
    },
    output: demo.read
  }
  receipt.key = mcpHash([receipt.name, receipt.args])
  h.backend.restore(receipt)
  await writeFile(join(h.lab.source, 'Helper.java'), 'class ChangedOnDisk {}')
  const again = await h.gateway.call('audit_read_related', receipt.args)
  assert.deepEqual(again, demo.read)
  await assert.rejects(
    h.gateway.call('audit_read_related', { ...receipt.args, targetId: 'rel-' + '0'.repeat(32) })
  )
  await assert.rejects(h.gateway.call('audit_read_related', { ...receipt.args, stepIndex: 999 }))
  const changed = structuredClone(receipt)
  changed.output.ranges[0].text = 'invented'
  assert.throws(() => h.backend.restore(changed), { code: 'RUN_MCP_CORRUPT' })
  const fractional = structuredClone(receipt)
  fractional.output.ranges[0].endLine += 0.5
  assert.throws(() => h.backend.restore(fractional), { code: 'MCP_INVALID_OUTPUT' })
})
test('supplement citations are accepted as frozen source but graph target IDs and scanner finding IDs cannot become quotes', async (t) => {
  const h = await fixture(t),
    demo = await runDemo(h),
    i = demo.read.stepIndex,
    base = {
      filePath: 'Service.java',
      startLine: 4,
      endLine: 7,
      text: h.query.snapshots
        .read(h.lab.projectId, h.lab.runId, 'Service.java')
        .split('\n')
        .slice(3, 7)
        .join('\n')
    },
    receipt = { name: demo.read.tool, args: { stepIndex: i }, output: demo.read },
    input = {
      ...h.backend.input,
      evidence: h.backend.input.path.steps.map(() => base),
      mcpReceipts: [receipt]
    }
  const result = {
    verdict: 'unknown',
    summary: 'Related source remains input passthrough',
    steps: input.path.steps.map((s) => ({
      stepIndex: s.stepIndex,
      dangerous: null,
      reason: 'unknown',
      quotes: [s.stepIndex === i ? demo.read.citations[0].id : base.text]
    }))
  }
  const resolved = resolveResultCitations(result, input)
  assert.doesNotThrow(() => validateResult(resolved, input))
  assert.ok(combinedEvidence(input, i).ranges.some((r) => r.filePath === 'Helper.java'))
  result.steps[i].quotes = ['finding-not-source']
  assert.throws(() => validateResult(result, input), { code: 'ANALYSIS_EVIDENCE_INVALID' })
  result.steps[i].quotes = [demo.read.citations[0].id.replace(/.$/, 'z')]
  assert.throws(() => resolveResultCitations(result, input), { code: 'ANALYSIS_EVIDENCE_INVALID' })
})
test('MCP parameter boundary rejects coercion, arbitrary paths, URLs, commands and recursive targets', () => {
  for (const args of [
    { stepIndex: '0' },
    { stepIndex: -1 },
    { stepIndex: 0, path: '../a' },
    { stepIndex: 0, command: 'whoami' },
    { stepIndex: 0, url: 'https://example.test' }
  ])
    assert.throws(() => mcpArgs('audit_static_scan', args, 2), { code: 'AGENT_TOOL_SCOPE' })
  assert.throws(() => mcpArgs('bash', { stepIndex: 0 }, 2))
})
test('static MCP reports unconfigured/version failures explicitly and never converts absence into safety', async () => {
  const result = await scanStatic(
    [{ filePath: 'A.java', source: 'class A {}' }],
    new AbortController().signal,
    ''
  )
  assert.equal(result.status, 'unavailable')
  assert.deepEqual(result.items, [])
  assert.equal(result.gaps[0], 'SEMGREP_NOT_CONFIGURED')
  const missing = await scanStatic(
    [{ filePath: 'A.java', source: 'class A {}' }],
    new AbortController().signal,
    resolve('missing-semgrep.exe')
  )
  assert.equal(missing.status, 'unavailable')
  const wrongVersion = await scanStatic(
    [{ filePath: 'A.java', source: 'class A {}' }],
    new AbortController().signal,
    process.execPath
  )
  assert.equal(wrongVersion.status, 'unavailable')
  assert.equal(wrongVersion.gaps[0], 'SEMGREP_VERSION_MISMATCH')
  await assert.rejects(
    scanStatic(
      [{ filePath: 'A.java', source: 'class A {}' }],
      AbortSignal.abort(),
      process.execPath
    ),
    { code: 'QUERY_CANCELLED' }
  )
})

test('v13 databases upgrade append-only to MCP receipts without altering old migration history or project rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-mcp-migration-')),
    db = new LocalDatabase(root)
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  migrate(db, migrations.slice(0, 13))
  const history = db.all('SELECT * FROM schema_migrations')
  db.run(
    "INSERT INTO projects(id,name,path,source_type,created_at,updated_at) VALUES('legacy','legacy','C:/fixture','local','now','now')"
  )
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 15)
  assert.deepEqual(db.all('SELECT * FROM schema_migrations WHERE version<=13'), history)
  assert.equal(db.get("SELECT name FROM projects WHERE id='legacy'").name, 'legacy')
  assert.ok(db.get("SELECT name FROM sqlite_schema WHERE name='tool_receipts'"))
})
test('standard stdio MCP client interoperates with the scoped CodeGraph server', async (t) => {
  const h = await fixture(t),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
        'scripts/mcp-lab.mjs',
        'serve',
        h.lab.labFile,
        'codegraph'
      ],
      cwd: resolve(import.meta.dirname, '..'),
      stderr: 'pipe'
    }),
    client = new Client({ name: 'independent-test', version: '1.0.0' })
  try {
    await client.connect(transport)
    const list = await client.listTools()
    assert.deepEqual(
      list.tools.map((t) => t.name),
      ['audit_find_related', 'audit_read_related']
    )
    const result = await client.callTool({
      name: 'audit_find_related',
      arguments: { stepIndex: 0, direction: 'outgoing' }
    })
    assert.equal(result.structuredContent.profile, MCP_PROFILE)
    assert.equal(result.structuredContent.snapshotId, h.backend.snapshot.snapshotId)
  } finally {
    await client.close()
    await transport.close()
  }
})
test(
  'real pinned Semgrep scans positive/negative Java without loading repository configuration',
  { skip: !process.env.PI_AUDIT_SEMGREP_PATH },
  async () => {
    const signal = new AbortController().signal
    const result = await scanStatic(
      [
        {
          filePath: 'A.java',
          source: 'class A { void a(String q){ stmt.executeQuery("SELECT "+q); } }'
        },
        { filePath: 'B.java', source: 'class B { void a(){ stmt.executeQuery("SELECT 1"); } }' }
      ],
      signal
    )
    assert.equal(result.engine, 'semgrep/' + SEMGREP_VERSION)
    assert.equal(result.status, 'ok', JSON.stringify(result))
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].filePath, 'A.java')
    assert.equal(result.items[0].confirmedVulnerability, false)
  }
)
