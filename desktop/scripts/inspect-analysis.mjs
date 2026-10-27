import { DatabaseSync } from 'node:sqlite'
import { resolve } from 'node:path'
if (!process.argv[2]) throw Error('用法：node scripts/inspect-analysis.mjs <audit.sqlite3 的路径>')
const db = new DatabaseSync(resolve(process.argv[2]), { readOnly: true, allowExtension: false })
try {
  console.log(
    JSON.stringify(
      {
        schema: db.prepare('PRAGMA user_version').get(),
        runs: db
          .prepare(
            'SELECT id,stage,status,error_code FROM audit_runs ORDER BY created_at DESC LIMIT 20'
          )
          .all(),
        paths: db
          .prepare('SELECT path_id,status,verdict,dangerous FROM call_paths LIMIT 100')
          .all(),
        events: db
          .prepare(
            'SELECT run_id,chain_id,seq,type,status,summary_missing,truncated FROM analysis_events ORDER BY run_id,seq LIMIT 100'
          )
          .all(),
        reports: db
          .prepare('SELECT id,status,summary_json,error_message FROM reports LIMIT 20')
          .all()
      },
      null,
      2
    )
  )
} finally {
  db.close()
}
