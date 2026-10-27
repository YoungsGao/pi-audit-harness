import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStorage, migrate, migrations } from '../src/service/storage/schema.ts'
import { LocalDatabase } from '../src/service/storage/database.ts'
import { SourceRepository } from '../src/service/sources/repository.ts'
import { scanJava } from '../src/service/sources/scan.ts'
import { importLocal, openProject } from '../src/service/sources/local.ts'
test('local without Git imports real Java bytes, duplicate is explicit, reopen detects changes; DB process connection persists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-local-'))
  const src = join(root, 'source')
  await mkdir(src)
  await writeFile(join(src, 'Demo.java'), 'class Demo {}')
  let db = openStorage(join(root, 'runtime'))
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  let repo = new SourceRepository(db)
  const saved = await importLocal(repo, { projectName: "Learner's project", path: src })
  assert.equal(saved.sourceType, 'local')
  assert.equal(saved.commit, null)
  assert.match(saved.sourceStamp, /^java-sha256:/)
  await assert.rejects(importLocal(repo, { projectName: 'again', path: src }), {
    code: 'SOURCE_DUPLICATE'
  })
  assert.equal(
    (await importLocal(repo, { projectName: 'ignored', path: src, duplicate: 'open' })).projectId,
    saved.projectId
  )
  db.close()
  db = openStorage(join(root, 'runtime'))
  repo = new SourceRepository(db)
  assert.equal(repo.catalog().projects[0].projectId, saved.projectId)
  assert.equal((await openProject(repo, saved.projectId)).changed, false)
  await writeFile(join(src, 'Demo.java'), 'class Demo { int n; }')
  assert.equal((await openProject(repo, saved.projectId)).changed, true)
  assert.notEqual(
    (await importLocal(repo, { projectName: 'new', path: src, duplicate: 'new' })).projectId,
    saved.projectId
  )
})
test('no Java, missing path, relative path and cancelled scan fail explicitly; ignored target is not source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'target'))
  await writeFile(join(root, 'target', 'Hidden.java'), 'class Hidden{}')
  await assert.rejects(scanJava(root), { code: 'SOURCE_NO_JAVA' })
  await assert.rejects(scanJava(join(root, 'absent')), { code: 'SOURCE_PATH_UNAVAILABLE' })
  await assert.rejects(scanJava('.'), { code: 'SOURCE_PATH_INVALID' })
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(scanJava(root, ctl.signal), { code: 'SOURCE_CANCELLED' })
})
test('migration 4 preserves version 3 rows and rolls back failed next migration', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pi-source-migrate-'))
  const db = new LocalDatabase(root)
  t.after(async () => {
    db.close()
    await rm(root, { recursive: true, force: true })
  })
  migrate(db, migrations.slice(0, 3))
  db.run(
    'INSERT INTO projects (id,name,path,source_type,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    'legacy',
    'kept',
    root,
    'local',
    'now',
    'now'
  )
  migrate(db)
  assert.equal(db.get('PRAGMA user_version').user_version, 8)
  assert.equal(db.get("SELECT name FROM projects WHERE id='legacy'").name, 'kept')
  assert.throws(() =>
    migrate(db, [
      ...migrations,
      {
        version: 9,
        name: 'broken-test',
        sql: 'CREATE TABLE should_rollback(id TEXT); INSERT INTO absent VALUES(1);'
      }
    ])
  )
  assert.equal(db.get('PRAGMA user_version').user_version, 8)
  assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='should_rollback'"), undefined)
})
