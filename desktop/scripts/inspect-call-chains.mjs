import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
if (process.argv.length !== 3) {
  console.error('用法: node scripts/inspect-call-chains.mjs <audit.sqlite3 文件>')
  process.exitCode = 2
} else {
  let db
  try {
    db = new DatabaseSync(resolve(process.argv[2]), { readOnly: true, allowExtension: false })
    console.log(
      JSON.stringify(
        {
          version: db.prepare('PRAGMA user_version').get().user_version,
          // 计数覆盖全部行，详情只取最近 20 个，避免把整个审计库打印出来。
          counts: db
            .prepare(
              'SELECT (SELECT count(*) FROM call_edges) AS edges, (SELECT count(*) FROM call_paths) AS paths, (SELECT count(*) FROM path_steps) AS steps'
            )
            .get(),
          runs: db
            .prepare(
              'SELECT id,project_id,status,source_stamp,rules_version FROM audit_runs ORDER BY created_at DESC LIMIT 20'
            )
            .all(),
          paths: db
            .prepare(
              'SELECT path_id,run_id,status,verdict,dangerous,truncated,truncation_reason FROM call_paths ORDER BY created_at DESC,path_id LIMIT 20'
            )
            .all(),
          steps: db
            .prepare(
              `SELECT s.path_id,s.step_index,e.file_path,e.call_line,e.call_column,e.caller_key,e.callee_key,e.resolution_status
        FROM path_steps s JOIN call_edges e ON e.uid=s.edge_uid AND e.run_id=s.run_id AND e.project_id=s.project_id
        WHERE s.path_id IN (SELECT path_id FROM call_paths ORDER BY created_at DESC,path_id LIMIT 20)
        ORDER BY s.path_id,s.step_index`
            )
            .all()
        },
        null,
        2
      )
    )
  } catch (error) {
    console.error('INSPECT_FAILED', error.message)
    process.exitCode = 1
  } finally {
    db?.close()
  }
}
