import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ResourceLoader, CreateAgentSessionResult } from '@earendil-works/pi-coding-agent'
import { ApiError } from '../shared/api-error.ts'
import { loadPiSdk } from './pi-sdk.ts'
import type { ResolvedModel } from './model-config-resolver.ts'
import { PiRuntime, throwIfCancelled, waitWithSignal } from './pi-runtime.ts'

export async function createManagedSession(
  runtime: PiRuntime,
  selected: ResolvedModel,
  resources: ResourceLoader,
  tools: string[],
  signal: AbortSignal,
  onExtensionError: () => void = () => {}
): Promise<CreateAgentSessionResult['session']> {
  const sdk = await waitWithSignal(loadPiSdk(), signal)
  const directory = join(runtime.workDir, randomUUID())
  await waitWithSignal(mkdir(directory, { recursive: true }), signal)
  const modelRuntime = await waitWithSignal(
    sdk.ModelRuntime.create({
      authPath: join(directory, 'unused-auth.json'),
      modelsPath: null,
      modelsStorePath: join(directory, 'models.sqlite'),
      refreshOnCreate: false,
      allowModelNetwork: false,
      signal
    }),
    signal
  )
  throwIfCancelled(signal)
  const config = selected.config
  modelRuntime.registerProvider('audit-configured', {
    api: config.api,
    baseUrl: config.baseUrl,
    apiKey: selected.apiKey,
    models: [
      {
        id: config.modelId,
        name: config.name,
        reasoning: false,
        input: ['text'],
        contextWindow: 8192,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  })
  const model = modelRuntime.getModel('audit-configured', config.modelId)
  if (!model) throw new ApiError('MODEL_NOT_AVAILABLE', '指定模型描述不可用', 400)
  const created = await waitWithSignal(
    sdk.createAgentSession({
      cwd: runtime.workDir,
      agentDir: runtime.agentDir,
      modelRuntime,
      model,
      resourceLoader: resources,
      tools,
      noTools: 'builtin',
      thinkingLevel: 'off',
      sessionManager: sdk.SessionManager.inMemory(runtime.workDir),
      settingsManager: sdk.SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false }
      })
    }),
    signal,
    (late) => late.session.dispose()
  )
  try {
    throwIfCancelled(signal)
    await waitWithSignal(
      created.session.bindExtensions({
        mode: 'json',
        onError: onExtensionError
      }),
      signal
    )
    return created.session
  } catch (error) {
    created.session.dispose()
    throw error
  }
}
