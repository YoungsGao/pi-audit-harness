// 正常关闭应用后使用；只读查看非敏感配置与选择状态，不读取系统凭据。
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, join } from 'node:path'
const [flag, root, ...rest] = process.argv.slice(2)
if (flag !== '--root' || !root || !isAbsolute(root) || rest.length) {
  throw new Error('Usage: node tests/mod01-inspect.mjs --root <absolute-runtime-directory>')
}
const db = new DatabaseSync(join(root, 'storage/audit.sqlite3'), { readOnly: true, timeout: 1000 })
try {
  console.log('Schema:', db.prepare('PRAGMA user_version').get().user_version)
  console.table(
    db
      .prepare(
        `SELECT s.config_id AS selectedConfigId,s.revision AS selectionRevision,
    m.name,m.model_id AS modelId,m.base_url AS baseUrl,m.revision AS configRevision
    FROM model_selection s LEFT JOIN model_configs m ON s.config_id=m.id WHERE s.slot=1`
      )
      .all()
  )
  console.table(
    db
      .prepare(
        `SELECT id AS configId,name,base_url AS baseUrl,model_id AS modelId,revision,
    CASE WHEN secret_ref IS NULL OR secret_ref='' THEN 'missing' ELSE 'referenced' END AS credentialState
    FROM model_configs ORDER BY updated_at DESC,id LIMIT 100`
      )
      .all()
  )
} finally {
  db.close()
}
