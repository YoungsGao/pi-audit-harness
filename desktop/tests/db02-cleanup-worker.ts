import { openStorage } from '../src/service/storage/schema'
import { WindowsCredentialStore } from '../src/service/storage/credential-store'
process.parentPort!.once('message', (event: { data: { root: string } }) => {
  void (async () => {
    const db = openStorage(event.data.root)
    let refs: string[]
    try {
      refs = db
        .all(
          'SELECT secret_ref FROM model_configs WHERE secret_ref IS NOT NULL UNION SELECT secret_ref FROM credential_cleanup'
        )
        .map((r) => String(r.secret_ref))
    } finally {
      db.close()
    }
    const vault = new WindowsCredentialStore()
    // 只清理本次隔离测试数据库记录的随机引用，绝不枚举或删除其他凭据。
    for (const ref of refs) await vault.delete(ref)
    process.exit(0)
  })().catch(() => process.exit(1))
})
