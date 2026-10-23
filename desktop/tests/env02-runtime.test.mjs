import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import test from 'node:test'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { loadPiSdk } from '../src/service/pi-sdk.ts'
import { createPiResources } from '../src/service/pi-resources.ts'

test('Pi 固定版本、初始化复用 Promise、应用目录隔离与停止状态', async () => {
  const root = resolve('.env02-test-data', randomUUID())
  const runtime = new PiRuntime(root)
  const first = runtime.initialize()
  assert.equal(first, runtime.initialize())
  await first
  assert.equal((await loadPiSdk()).VERSION, '1.2.0')
  assert.equal(runtime.getStatus().state, 'ready')
  assert.ok(runtime.agentDir.startsWith(root))
  await runtime.close()
  await runtime.close()
  assert.equal(runtime.getStatus().state, 'stopped')
  await assert.rejects(runtime.initialize(), (error) => error.code === 'SERVICE_STOPPING')
})

test('资源加载器拒绝扩展工厂加载错误，不读取用户扩展', async () => {
  const root = resolve('.env02-test-data', randomUUID())
  await mkdir(root, { recursive: true })
  const empty = await createPiResources(root, root)
  assert.equal(empty.getExtensions().extensions.length, 0)
  assert.equal(empty.getSkills().skills.length, 0)
  await assert.rejects(
    createPiResources(root, root, [
      () => {
        throw new Error('fixture failure')
      }
    ]),
    (error) => error.code === 'PI_EXTENSION_LOAD_FAILED'
  )
})
