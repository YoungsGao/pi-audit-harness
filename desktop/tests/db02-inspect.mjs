// 后端学习辅助脚本：正常关闭应用后，只读查看元数据和凭据引用，不读取系统 Key。
import { DatabaseSync } from 'node:sqlite'
import { isAbsolute, join } from 'node:path'
const [flag, root, ...rest] = process.argv.slice(2)
if (flag !== '--root' || !root || !isAbsolute(root) || rest.length) {
  throw new Error('Usage: node tests/db02-inspect.mjs --root <absolute-runtime-directory>')
}
const db = new DatabaseSync(join(root, 'storage/audit.sqlite3'), { readOnly: true, timeout: 1000 })
try {
  console.log('Schema:', db.prepare('PRAGMA user_version').get().user_version)
  console.table(
    db
      .prepare(
        'SELECT id AS projectId,name AS projectName,path,source_type AS sourceType,git_url AS gitUrl,git_commit AS commitHash,git_dirty AS dirty,revision FROM projects'
      )
      .all()
  )
  console.table(
    db
      .prepare(
        'SELECT id AS configId,name,base_url AS baseUrl,model_id AS modelId,secret_ref AS secretRef,revision FROM model_configs'
      )
      .all()
  )
  console.log(
    'Pending credential cleanup:',
    db.prepare('SELECT count(*) AS n FROM credential_cleanup').get().n
  )
} finally {
  db.close()
}
