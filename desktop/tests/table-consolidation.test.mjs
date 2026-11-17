import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { migrate, migrations } from '../src/service/storage/schema.ts'
import { StreamRepository } from '../src/service/storage/stream-events.ts'
import { AnalysisEventRepository } from '../src/service/storage/analysis-events.ts'
import {
  TemplateRepository,
  reviewContextHash
} from '../src/service/storage/template-repository.ts'
import { SnapshotRepository } from '../src/service/storage/snapshot-repository.ts'
import { ReviewRepository } from '../src/service/storage/review-repository.ts'
import { GraphRepository } from '../src/service/storage/graph-repository.ts'
import { CallChainRepository } from '../src/service/storage/call-chain-repository.ts'
import { retryWrite } from '../src/service/storage/retry-write.ts'
import { ApiError } from '../src/shared/api-error.ts'
import { createAgentHarness } from './agent-harness.mjs'
const hash = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex')
const scope = { projectId: 'project', runId: 'run', pathId: 'path' }
function legacy(t) {
  const root = mkdtempSync(join(tmpdir(), 'pi-v14-consolidation-')),
    db = new LocalDatabase(root)
  t.after(() => {
    db.close()
    rmSync(root, { recursive: true, force: true })
  })
  migrate(db, migrations.slice(0, 14))
  db.exec(`INSERT INTO projects(id,name,path,source_type,created_at,updated_at) VALUES('project','kept','C:/demo','local','old','old');
    INSERT INTO model_configs(id,name,base_url,model_id,revision) VALUES('model','fixture','https://example.invalid/v1','fixture',1);
    INSERT INTO source_imports VALUES('project','source-key','stamp',1,12,'old');
    INSERT INTO audit_runs(id,project_id,status,source_stamp,rules_version,created_at,updated_at,stage) VALUES('run','project','failed','stamp','rules','old','old','failed');
    INSERT INTO scan_runs(run_id,project_id,state,candidate_count,warnings_json,started_at,finished_at) VALUES('run','project','ready',1,'[]','start','finish');
    INSERT INTO call_edges(uid,run_id,project_id,file_path,caller_key,callee_key,call_line,is_sink) VALUES('edge','run','project','A.java','A.a','Sink',1,1);
    INSERT INTO call_paths(path_id,run_id,project_id,path_hash,sink_edge_id,verdict,result_summary,created_at,updated_at,status) VALUES('path','run','project','path-hash','edge','unknown','','old','old','failed');
    INSERT INTO path_steps(path_id,step_index,edge_uid,run_id,project_id) VALUES('path',0,'edge','run','project');
    INSERT INTO project_review_settings VALUES('project',2,'wrapper','input','defense','focus','old');
    INSERT INTO run_controls VALUES('run','project','interrupted',7,'old','null');
    INSERT INTO path_attempts(path_id,run_id,project_id,attempt,model_config_id,phase,started_at,finished_at,error_code) VALUES('path','run','project',2,'model','failed','old','old','LEGACY_ERROR');
    INSERT INTO analysis_sessions(session_id,run_id,project_id,chain_id,attempt_id,model_config_id,state,min_event_id,created_at,finished_at) VALUES('session','run','project','path',1,'model','completed',2,'old','old');
    INSERT INTO analysis_sessions(session_id,run_id,project_id,chain_id,attempt_id,model_config_id,state,created_at,finished_at) VALUES('session2','run','project','path',2,'model','error','old','old');`)
  const source = 'class A {}\n',
    sha = hash(source),
    manifest = [{ filePath: 'A.java', sha256: sha, size: Buffer.byteLength(source) }]
  db.run(
    'INSERT INTO source_snapshots VALUES(?,?,?,?,?,?,?)',
    'snapshot',
    'project',
    'stamp',
    JSON.stringify(manifest),
    '[]',
    null,
    'old'
  )
  db.run(
    'INSERT INTO snapshot_files VALUES(?,?,?,?)',
    'snapshot',
    'A.java',
    sha,
    Buffer.from(source)
  )
  db.exec("INSERT INTO run_snapshots VALUES('run','project','snapshot')")
  const projectReview = {
    projectId: 'project',
    revision: 2,
    businessWrappers: 'wrapper',
    inputSources: 'input',
    defenseConventions: 'defense',
    focus: 'focus',
    updatedAt: 'old'
  }
  const review = {
    projectId: 'project',
    runId: 'run',
    state: 'saved',
    templates: [],
    projectReview,
    contextHash: reviewContextHash([], projectReview),
    createdAt: 'old'
  }
  db.run(
    'INSERT INTO run_review_configs VALUES(?,?,?,?,?)',
    'run',
    'project',
    JSON.stringify(review),
    review.contextHash,
    'old'
  )
  const graph = { identity: 'legacy-frozen-graph', facts: [] }
  db.run(
    'INSERT INTO run_graph_bindings VALUES(?,?,?,?,?)',
    'run',
    'project',
    JSON.stringify(graph),
    hash(graph),
    'old'
  )
  for (let n = 1; n <= 2; n++)
    db.run(
      'INSERT INTO manual_risk_points VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
      'point' + n,
      'project',
      'run',
      'snapshot',
      'path',
      'A.java',
      n,
      1,
      null,
      'rule',
      'note' + n,
      'old'
    )
  db.exec(`INSERT INTO disclosure_grants VALUES('scope','project','snapshot','{}','old');
    INSERT INTO source_transmissions VALUES('transmission','project','run','path',1,'scope','model',1,'https://example.invalid/v1','fixture','observed','old');
    INSERT INTO recovery_requests VALUES('request','journey','path','run','project',1,'received','{"tokens":123}','old','old');`)
  const evidence = {
    filePath: 'A.java',
    startLine: 1,
    endLine: 1,
    text: 'class A {}',
    complete: true
  }
  db.run(
    'INSERT INTO recovery_tools VALUES(?,?,?,?,?,?,?,?,?,?)',
    'journey',
    0,
    'path',
    'run',
    'project',
    'binding',
    JSON.stringify(evidence),
    hash(evidence),
    1,
    'old'
  )
  const receipt = {
    key: 'mcp-key',
    name: 'audit_static_scan',
    args: { stepIndex: 0 },
    output: { status: 'unavailable' }
  }
  db.run(
    'INSERT INTO recovery_mcp_tools VALUES(?,?,?,?,?,?,?,?,?)',
    'journey',
    'mcp-key',
    'path',
    'run',
    'project',
    'binding',
    JSON.stringify(receipt),
    hash(receipt),
    'old'
  )
  db.run(
    'INSERT INTO recovery_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    'checkpoint',
    'path',
    'run',
    'project',
    'journey',
    1,
    1,
    'binding',
    'pi',
    'leaf',
    'checkpoint.jsonl',
    'sha',
    123,
    '{}',
    'old'
  )
  const events = [
    ['analyzing', 'process', 'analyzing', '领取', { attempt: 1 }],
    ['tool_call_info', 'tool', 'completed', '读取', { output: evidence }],
    ['completed', 'result', 'completed', '结束', { verdict: 'unknown' }]
  ]
  for (let i = 0; i < events.length; i++) {
    const [event, type, status, message, payload] = events[i],
      id = i + 2
    db.run(
      'INSERT INTO analysis_events VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      'event' + i,
      'run',
      'project',
      'path',
      i + 1,
      'old',
      type,
      message,
      0,
      null,
      null,
      status,
      null,
      JSON.stringify(payload),
      0
    )
    const data = {
      projectId: 'project',
      runId: 'run',
      chainId: 'path',
      sessionId: 'session',
      attemptId: 1,
      type: type === 'result' ? 'result' : 'process',
      status: type === 'result' ? 'completed' : 'analyze',
      message,
      summaryMissing: false,
      details: { payload, toolCallId: null, toolName: null, durationMs: null, truncated: false }
    }
    db.run(
      'INSERT INTO stream_events VALUES(?,?,?,?,?)',
      'session',
      id,
      event,
      JSON.stringify(data),
      'old'
    )
  }
  const path = db.get(
      'SELECT status,verdict,dangerous,result_summary,updated_at,path_hash FROM call_paths WHERE path_id=?',
      'path'
    ),
    attempt = db.get('SELECT attempt,phase FROM path_attempts WHERE path_id=?', 'path')
  const baseline = {
    version: hash({ path, attempt }),
    status: path.status,
    verdict: path.verdict,
    updatedAt: path.updated_at,
    attempt: 2
  }
  db.run(
    'INSERT INTO path_review_versions VALUES(?,?,?,?,?,?,?,?)',
    'project',
    'run',
    'path',
    1,
    'needs_more_info',
    'human-note',
    JSON.stringify(baseline),
    'old'
  )
  return { db, source, projectReview, review, graph, receipt, evidence }
}
test('v14 → v15 retains source bytes, frozen inputs, every manual point, human baseline, receipts and exact SSE cursor/data', (t) => {
  const h = legacy(t),
    { db } = h,
    history = db.all('SELECT * FROM schema_migrations ORDER BY version')
  const frames = db.all('SELECT * FROM stream_events ORDER BY id')
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 15)
  assert.equal(db.all("SELECT name FROM sqlite_schema WHERE type='table'").length, 21)
  assert.deepEqual(
    db.all('SELECT * FROM schema_migrations WHERE version<=14 ORDER BY version'),
    history
  )
  assert.deepEqual(db.all('PRAGMA foreign_key_check'), [])
  assert.equal(new SnapshotRepository(db).read('project', 'run', 'A.java'), h.source)
  assert.deepEqual(new TemplateRepository(db).project('project'), h.projectReview)
  assert.deepEqual(new TemplateRepository(db).run('project', 'run'), h.review)
  assert.deepEqual(new GraphRepository(db).get('project', 'run'), h.graph)
  assert.equal(
    JSON.parse(db.get('SELECT manual_points_json FROM call_paths').manual_points_json).length,
    2
  )
  assert.equal(new CallChainRepository(db).manualPoint('project', 'run', 'path').note, 'note1')
  assert.equal(new ReviewRepository(db).get(scope).stale, false)
  assert.deepEqual(
    { ...db.get('SELECT control_state,control_revision,candidate_count FROM audit_runs') },
    { control_state: 'interrupted', control_revision: 7, candidate_count: 1 }
  )
  assert.equal(
    db.get("SELECT error_code FROM analysis_sessions WHERE session_id='session2'").error_code,
    'LEGACY_ERROR'
  )
  assert.deepEqual(
    JSON.parse(
      db.get("SELECT receipt_json FROM tool_receipts WHERE request_key='mcp-key'").receipt_json
    ),
    h.receipt
  )
  assert.equal(db.get('SELECT count(*) n FROM recovery_checkpoints').n, 1)
  assert.equal(
    db.get('SELECT count(*) n FROM model_requests').n,
    2,
    'legacy requests have no shared ID; do not invent a correspondence'
  )
  const stream = new StreamRepository(db),
    input = {
      projectId: 'project',
      runId: 'run',
      chainId: 'path',
      modelConfigId: 'model',
      sessionId: 'session',
      afterId: 1
    }
  assert.deepEqual(
    stream.list(input).frames,
    frames.map((f) => ({ id: f.id, event: f.event, data: JSON.parse(f.data_json) }))
  )
  assert.throws(() => stream.list({ ...input, afterId: 0 }), { code: 'SSE_HISTORY_EXPIRED' })
  assert.equal(new AnalysisEventRepository(db).list('project', 'run', 'path').events.length, 3)
  assert.equal(
    db.get('SELECT count(*) n FROM audit_events').n,
    3,
    'matched historical events are stored once'
  )
  db.exec(
    "INSERT INTO projects(id,name,path,source_type,created_at,updated_at) VALUES('other','other','C:/other','local','old','old'); INSERT INTO audit_runs(id,project_id,status,source_stamp,rules_version,created_at,updated_at,snapshot_id) VALUES('scope-test','project','queued','stamp','rules','old','old','snapshot')"
  )
  assert.throws(() => db.exec("UPDATE audit_runs SET project_id='other' WHERE id='scope-test'"), {
    code: 'DB_QUERY_FAILED'
  })
})
test('failed consolidation rolls back data, dropped tables and version as one transaction', (t) => {
  const { db } = legacy(t)
  assert.throws(
    () =>
      migrate(db, [
        ...migrations.slice(0, 14),
        { ...migrations[14], sql: migrations[14].sql + 'INSERT INTO absent VALUES(1);' }
      ]),
    { code: 'DB_QUERY_FAILED' }
  )
  assert.equal(db.get('PRAGMA user_version').user_version, 14)
  assert.equal(db.all("SELECT name FROM sqlite_schema WHERE type='table'").length, 33)
  assert.equal(db.get('SELECT count(*) n FROM stream_events').n, 3)
  assert.equal(db.get('SELECT note FROM manual_risk_points ORDER BY point_id').note, 'note1')
  assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='audit_events'"), undefined)
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 15)
})
test('legacy attempt without a session and unmatched SSE data are retained without fabricated task events', (t) => {
  const { db } = legacy(t)
  db.exec(
    "DELETE FROM analysis_sessions WHERE session_id='session2'; DELETE FROM analysis_events WHERE event_id='event1'"
  )
  const frames = db.all('SELECT * FROM stream_events ORDER BY id')
  migrate(db)
  const recovered = db.get("SELECT * FROM analysis_sessions WHERE chain_id='path' AND attempt_id=2")
  assert.match(recovered.session_id, /^legacy-attempt-/)
  assert.equal(recovered.state, 'error')
  assert.equal(recovered.error_code, 'LEGACY_ERROR')
  assert.equal(recovered.created_at, 'old')
  const input = {
    projectId: 'project',
    runId: 'run',
    chainId: 'path',
    modelConfigId: 'model',
    sessionId: 'session',
    afterId: 1
  }
  assert.deepEqual(
    new StreamRepository(db).list(input).frames,
    frames.map((f) => ({ id: f.id, event: f.event, data: JSON.parse(f.data_json) }))
  )
  assert.equal(new AnalysisEventRepository(db).list('project', 'run', 'path').events.length, 2)
  assert.equal(db.get('SELECT count(*) n FROM audit_events WHERE seq IS NULL').n, 1)
  assert.equal(new ReviewRepository(db).get(scope).stale, false)
})
test('production Pi flow stores each new request/event once, and expiring SSE leaves the audit log intact', async (t) => {
  const h = await createAgentHarness(t, 'finish'),
    pathId = h.prepared.pathIds[0]
  await h.chains.action('analyze', { ...h.scope, pathId, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  assert.equal(h.repo.detail({ ...h.scope, pathId }).status, 'unresolved')
  const requests = h.db.all('SELECT * FROM model_requests')
  assert.equal(requests.length, h.model.requests.length)
  assert.ok(
    requests.every((r) => r.journey_id && r.config_id === 'model' && r.state === 'received')
  )
  const rows = h.db.all('SELECT * FROM audit_events WHERE chain_id=?', pathId)
  assert.ok(
    rows.filter((r) => r.session_id && r.stream_event !== 'queued').every((r) => r.seq !== null)
  )
  assert.equal(
    rows.filter((r) => r.seq !== null).length + 1,
    rows.length,
    'only queued is an SSE-only event'
  )
  const session = h.repo.scans.streams.current(h.scope.projectId, h.scope.runId, pathId)
  const input = {
    ...h.scope,
    chainId: pathId,
    modelConfigId: 'model',
    sessionId: session.session_id,
    afterId: 0
  }
  const before = h.repo.scans.streams.list(input)
  assert.equal(before.frames.length, rows.filter((r) => r.session_id).length)
  h.repo.scans.streams.expire(session.session_id, 1)
  assert.equal(
    h.db.get('SELECT count(*) n FROM audit_events WHERE chain_id=?', pathId).n,
    rows.length
  )
  assert.throws(() => h.repo.scans.streams.list(input), { code: 'SSE_HISTORY_EXPIRED' })
  assert.deepEqual(
    h.repo.scans.streams.list({ ...input, afterId: 1 }).frames,
    before.frames.slice(1)
  )
})
test('write retry repeats only transient SQLite lock errors; constraints fail immediately', async (t) => {
  let calls = 0
  await assert.rejects(
    retryWrite(() => {
      calls++
      throw new ApiError('DB_QUERY_FAILED', 'constraint')
    }),
    { code: 'DB_QUERY_FAILED' }
  )
  assert.equal(calls, 1)
  calls = 0
  assert.equal(
    await retryWrite(() => {
      if (++calls < 3) throw new ApiError('DB_QUERY_FAILED', 'busy', 500, true)
      return 'ok'
    }),
    'ok'
  )
  assert.equal(calls, 3)
  const { db } = legacy(t)
  assert.throws(
    () =>
      db.exec(
        "INSERT INTO projects(id,name,path,source_type,created_at,updated_at) VALUES('project','duplicate','C:/demo','local','old','old')"
      ),
    (error) => error.code === 'DB_QUERY_FAILED' && error.retryable === false
  )
  const other = new LocalDatabase(dirname(dirname(db.filePath)))
  db.exec('BEGIN IMMEDIATE')
  try {
    assert.throws(
      () => other.run("UPDATE projects SET name='locked' WHERE id='project'"),
      (error) => error.code === 'DB_QUERY_FAILED' && error.retryable === true
    )
  } finally {
    db.exec('ROLLBACK')
    other.close()
  }
})
