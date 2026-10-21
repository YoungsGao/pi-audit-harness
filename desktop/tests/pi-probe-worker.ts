import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { loadPiSdk } from '../src/service/pi-adapter'
import type { ResourceLoader } from '@earendil-works/pi-coding-agent'

void (async () => {
  const sdk = await loadPiSdk()
  const directory = resolve('.api01-test-data', randomUUID())
  await mkdir(directory, { recursive: true })
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: resolve(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: resolve(directory, 'models.sqlite'),
    refreshOnCreate: false,
    allowModelNetwork: false
  })
  modelRuntime.registerProvider('offline-session-probe', {
    baseUrl: 'http://127.0.0.1:1/v1',
    api: 'openai-completions',
    apiKey: 'fixture-key-not-a-real-secret',
    models: [
      {
        id: 'offline-model',
        name: '仅验证会话创建',
        reasoning: false,
        input: ['text'],
        contextWindow: 8192,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  })
  const model = modelRuntime.getModel('offline-session-probe', 'offline-model')
  if (!model) throw new Error('离线测试模型描述未注册')
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '仅检查会话创建，不调用模型。',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  }
  const { session } = await sdk.createAgentSession({
    cwd: directory,
    agentDir: directory,
    model,
    modelRuntime,
    resourceLoader,
    tools: [],
    noTools: 'all',
    thinkingLevel: 'off',
    sessionManager: sdk.SessionManager.inMemory(directory),
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } })
  })
  try {
    if (session.getActiveToolNames().length !== 0) throw new Error('探针不应启用工具')
    process.parentPort.postMessage({ ok: true, modelRequests: 0, stage: 'session-created' })
  } finally {
    session.dispose()
  }
  process.exit(0)
})().catch((error: unknown) => {
  process.parentPort.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : '离线探针失败'
  })
  process.exit(1)
})
