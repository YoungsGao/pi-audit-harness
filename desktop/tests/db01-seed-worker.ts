import { openStorage } from '../src/service/storage/schema'
import { AuditRepository } from '../src/service/storage/repository'
import { completedFixture } from './db01-fixture.mjs'
const parent = process.parentPort!
parent.once('message', (event: { data: { root: string } }) => {
  try {
    const db = openStorage(event.data.root)
    try {
      new AuditRepository(db).saveCompletedAudit(completedFixture())
    } finally {
      db.close()
    }
    parent.postMessage({ ok: true, node: process.versions.node })
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
