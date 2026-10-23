import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { openStorage, migrate, migrations } from '../src/service/storage/schema.ts'
import { CallChainRepository, callEdgeUid } from '../src/service/storage/call-chain-repository.ts'
import { expandCandidatePaths } from '../src/service/chains/paths.ts'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-chains-'))
  const db = openStorage(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  db.run(
    "INSERT INTO projects (id,name,path,source_type,created_at,updated_at) VALUES ('project','sample','C:/sample','local','now','now')"
  )
  return { db, repo: new CallChainRepository(db), root }
}
function edge(callerKey, calleeKey, callLine, extra = {}) {
  return {
    filePath: 'Demo.java',
    callerKey,
    calleeKey,
    callLine,
    callColumn: 5,
    functionName: callerKey,
    calledFunctionName: calleeKey,
    calledFilePath: null,
    resolutionStatus: 'candidate',
    isSink: false,
    ruleId: null,
    arguments: [],
    ...extra
  }
}
function graph() {
  const edges = [
    edge('A#start(String)', 'Shared#query(String)', 3),
    edge('B#start(String)', 'Shared#query(String)', 6),
    edge('Shared#query(String)', 'Statement#executeQuery(String)', 10, {
      isSink: true,
      ruleId: 'JAVA-SQL-STATEMENT'
    })
  ]
  const ids = edges.map((e) => callEdgeUid('run', e))
  return {
    projectId: 'project',
    runId: 'run',
    sourceStamp: 'java-sha256:fixture',
    rulesVersion: 'rules-fixture-v1',
    edges,
    paths: [
      [ids[0], ids[2]],
      [ids[1], ids[2]]
    ].map((edgeUids) => ({
      edgeUids,
      sinkEdgeUid: ids[2],
      sourceRef: null,
      ruleId: 'JAVA-SQL-STATEMENT',
      truncated: false,
      truncationReason: ''
    }))
  }
}

test('transaction stores shared edge once, two ordered paths, rule version and NULL unknown; retry deduplicates', (t) => {
  const { db, repo } = fixture(t),
    input = graph()
  const first = repo.saveGraph(input)
  const second = repo.saveGraph(input)
  assert.deepEqual(second, first)
  assert.equal(db.get('SELECT count(*) AS n FROM call_edges').n, 3)
  assert.equal(db.get('SELECT count(*) AS n FROM call_paths').n, 2)
  assert.equal(db.get('SELECT count(*) AS n FROM path_steps').n, 4)
  assert.equal(db.get('SELECT rules_version FROM audit_runs').rules_version, input.rulesVersion)
  const detail = repo.detail({ projectId: 'project', runId: 'run', pathId: first.pathIds[0] })
  assert.deepEqual(
    detail.steps.map((s) => s.stepIndex),
    [0, 1]
  )
  assert.equal(detail.steps[1].edge.isSink, true)
  assert.equal(detail.dangerous, null)
  assert.equal(detail.verdict, 'unknown')
  assert.equal(detail.status, 'pending')
  assert.equal(repo.list({ projectId: 'project', runId: 'run', limit: 1 }).total, 2)
  assert.throws(() => repo.detail({ projectId: 'other', runId: 'run', pathId: first.pathIds[0] }), {
    code: 'CHAIN_NOT_FOUND'
  })
  db.run('UPDATE path_steps SET dangerous=1 WHERE path_id=? AND step_index=1', first.pathIds[0])
  assert.equal(
    repo.detail({ projectId: 'project', runId: 'run', pathId: first.pathIds[1] }).steps[1]
      .dangerous,
    null
  )
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
})

test('rollback, immutable call-site identity, disconnected path and wrong-run references cannot corrupt graph', (t) => {
  const { db, repo } = fixture(t),
    input = graph()
  const broken = structuredClone(input)
  broken.paths[1].edgeUids.push('missing')
  assert.throws(() => repo.saveGraph(broken))
  assert.equal(db.get('SELECT count(*) AS n FROM audit_runs').n, 0)
  db.exec(
    "CREATE TRIGGER reject_test_path BEFORE INSERT ON call_paths WHEN NEW.source_ref='reject-fixture' BEGIN SELECT RAISE(ABORT,'test storage failure'); END;"
  )
  const lateFailure = structuredClone(input)
  lateFailure.paths[1].sourceRef = 'reject-fixture'
  assert.throws(() => repo.saveGraph(lateFailure), { code: 'DB_QUERY_FAILED' })
  assert.equal(db.get('SELECT count(*) AS n FROM audit_runs').n, 0)
  assert.equal(db.get('SELECT count(*) AS n FROM call_edges').n, 0)
  assert.equal(db.get('SELECT count(*) AS n FROM call_paths').n, 0)
  db.exec('DROP TRIGGER reject_test_path')
  repo.saveGraph(input)
  const conflict = structuredClone(input)
  conflict.edges[0].calleeKey = 'Different#method()'
  assert.equal(callEdgeUid('run', conflict.edges[0]), callEdgeUid('run', input.edges[0]))
  assert.throws(() => repo.saveGraph({ ...conflict, paths: [] }), { code: 'CHAIN_EDGE_CONFLICT' })
  assert.throws(() => repo.saveGraph({ ...input, sourceStamp: 'different' }), {
    code: 'CHAIN_RUN_CONFLICT'
  })
  const disconnected = structuredClone(input)
  disconnected.paths[0].edgeUids = [
    callEdgeUid('run', input.edges[0]),
    callEdgeUid('run', input.edges[1])
  ]
  assert.throws(() => repo.saveGraph(disconnected), { code: 'CHAIN_INVALID_INPUT' })
  assert.throws(() => db.run('UPDATE call_paths SET truncated=1'), { code: 'DB_QUERY_FAILED' })
  db.run(
    "INSERT INTO audit_runs VALUES ('other-run','project','queued','same','same',NULL,'now','now')"
  )
  assert.throws(() => db.run('UPDATE path_steps SET run_id=?', 'other-run'), {
    code: 'DB_QUERY_FAILED'
  })
})

test('bounded reverse expansion represents branches, repeated recursion and depth/node/path cutoffs', () => {
  const base = graph(),
    edges = base.edges.map((e) => ({ ...e, uid: callEdgeUid('run', e) })),
    sink = edges[2].uid
  const paths = expandCandidatePaths(edges, sink)
  assert.equal(paths.length, 2)
  assert.deepEqual(
    paths.map((p) => p.edgeUids.length),
    [2, 2]
  )
  assert.equal(
    expandCandidatePaths(edges, sink, { maxDepth: 1 })[0].truncationReason,
    'depth-limit'
  )
  assert.equal(expandCandidatePaths(edges, sink, { maxNodes: 1 })[0].truncationReason, 'node-limit')
  assert.equal(expandCandidatePaths(edges, sink, { maxPaths: 1 })[0].truncationReason, 'path-limit')
  const recursive = edge('Shared#query(String)', 'Shared#query(String)', 8)
  const cycle = { ...recursive, uid: callEdgeUid('run', recursive) }
  const recursivePaths = expandCandidatePaths([cycle, edges[2]], sink)
  assert.equal(recursivePaths[0].truncationReason, 'recursion')
  assert.equal(new Set(recursivePaths[0].edgeUids).size < recursivePaths[0].edgeUids.length, true)
})

test('v4 upgrade preserves historical rows/checksums and new migration failure rolls back', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pi-chain-upgrade-')),
    db = new LocalDatabase(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  migrate(db, migrations.slice(0, 4))
  db.run(
    "INSERT INTO projects (id,name,path,source_type,created_at,updated_at) VALUES ('old','old','C:/old','local','old','old')"
  )
  db.run(
    "INSERT INTO audit_runs VALUES ('r','old','completed','stamp','old-rules',NULL,'old','old')"
  )
  db.run("INSERT INTO call_edges VALUES ('e','r','old','Old.java','Old#a','Db#query',1,1,NULL)")
  db.run("INSERT INTO call_paths VALUES ('p','r','old','hash','e','unknown',NULL,'legacy','old')")
  db.run("INSERT INTO path_steps VALUES ('p',0,'e','r','old')")
  const checksums = db.all('SELECT checksum FROM schema_migrations ORDER BY version')
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 6)
  assert.deepEqual(
    db.all('SELECT checksum FROM schema_migrations WHERE version<=4 ORDER BY version'),
    checksums
  )
  assert.equal(db.get("SELECT status FROM call_paths WHERE path_id='p'").status, 'completed')
  assert.equal(db.get('SELECT count(*) AS n FROM path_steps').n, 1)
  assert.throws(() =>
    migrate(db, [
      ...migrations,
      {
        version: 7,
        name: 'broken',
        sql: 'CREATE TABLE no_commit(id); SELECT * FROM missing_table;'
      }
    ])
  )
  assert.equal(db.get('PRAGMA user_version').user_version, 6)
  assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='no_commit'"), undefined)
})
