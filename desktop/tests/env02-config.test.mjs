import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveModelConfig } from '../src/service/model-config-resolver.ts'
import { createManagedSession } from '../src/service/pi-session-factory.ts'
import { createPiResources } from '../src/service/pi-resources.ts'
import { PiRuntime } from '../src/service/pi-runtime.ts'
import { createEnv02Fixture } from './env02-fixture.mjs'

test('配置快照不跟随后续修改、缺少配置与凭据有明确错误', async () => {
  const fixture = await createEnv02Fixture()
  const signal = new AbortController().signal
  try {
    const selected = await resolveModelConfig(fixture.config.id, fixture.ports, signal)
    fixture.config.modelId = 'new-model'
    assert.equal(selected.config.modelId, 'fixture-model')
    assert.equal(Object.isFrozen(selected.config), true)
    await assert.rejects(
      resolveModelConfig('missing', fixture.ports, signal),
      (error) => error.code === 'MODEL_CONFIG_NOT_FOUND'
    )
    await assert.rejects(
      resolveModelConfig(
        fixture.config.id,
        { ...fixture.ports, readSecret: async () => undefined },
        signal
      ),
      (error) => error.code === 'MODEL_CREDENTIAL_MISSING'
    )
  } finally {
    await fixture.close()
  }
})

test('共用工厂创建并释放真实会话，初始化与配置读取不发送模型请求', async () => {
  const fixture = await createEnv02Fixture()
  const runtime = new PiRuntime(fixture.directory)
  let session
  try {
    await runtime.initialize()
    const signal = new AbortController().signal
    const selected = await resolveModelConfig(fixture.config.id, fixture.ports, signal)
    const resources = await createPiResources(runtime.workDir, runtime.agentDir)
    session = await createManagedSession(runtime, selected, resources, [], signal)
    assert.equal(session.model.id, 'fixture-model')
    assert.deepEqual(session.getActiveToolNames(), [])
    assert.equal(fixture.requests.length, 0)
  } finally {
    session?.dispose()
    await runtime.close()
    await fixture.close()
  }
})
