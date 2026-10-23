import { openStorage } from '../src/service/storage/schema.ts'
import { AuditRepository } from '../src/service/storage/repository.ts'
import { completedFixture } from './db01-fixture.mjs'
const [root, operation] = process.argv.slice(2)
const db = openStorage(root)
try {
  const repo = new AuditRepository(db)
  if (operation === 'seed') repo.saveCompletedAudit(completedFixture())
  process.stdout.write(JSON.stringify(repo.overview()))
} finally {
  db.close()
}
