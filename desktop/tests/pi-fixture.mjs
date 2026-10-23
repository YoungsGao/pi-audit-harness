import { createServer } from 'node:http'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as sdk from '@earendil-works/pi-coding-agent'

export async function createPiFixture({ holdReply = false } = {}) {
  let requests = 0
  const server = createServer((request, response) => {
    requests += 1
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end()
      return
    }
    request.resume()
    if (holdReply) return
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta, finish_reason) => ({
      id: 'local-test',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'offline-model',
      choices: [{ index: 0, delta, finish_reason }]
    })
    response.write(
      'data: ' +
        JSON.stringify(chunk({ role: 'assistant', content: '本地测试回复' }, null)) +
        '\n\n'
    )
    response.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const directory = resolve('.api01-test-data', randomUUID())
  await mkdir(directory, { recursive: true })
  const modelRuntime = await sdk.ModelRuntime.create({
    authPath: resolve(directory, 'auth.json'),
    modelsPath: null,
    modelsStorePath: resolve(directory, 'models.sqlite'),
    refreshOnCreate: false,
    allowModelNetwork: false
  })
  modelRuntime.registerProvider('audit-local-test', {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    api: 'openai-completions',
    apiKey: 'fixture-key-not-a-real-secret',
    models: [
      {
        id: 'offline-model',
        name: '本地测试模型',
        reasoning: false,
        input: ['text'],
        contextWindow: 8192,
        maxTokens: 128,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      }
    ]
  })
  const runtime = sdk.createExtensionRuntime()
  const resourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => '仅用于本地接口测试。',
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {}
  }
  return {
    options: {
      cwd: directory,
      agentDir: directory,
      modelRuntime,
      model: modelRuntime.getModel('audit-local-test', 'offline-model'),
      resourceLoader
    },
    get requestCount() {
      return requests
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
