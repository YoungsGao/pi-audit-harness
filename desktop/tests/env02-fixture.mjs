import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

export async function createEnv02Fixture({ holdReply = false, errorStatus } = {}) {
  const requests = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const part of request) chunks.push(part)
    const input = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(input)
    if (errorStatus) {
      response.writeHead(errorStatus, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          error: { message: 'fixture-secret-must-not-leak', type: 'fixture_error' }
        })
      )
      return
    }
    if (holdReply) return
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    function chunk(delta, finish_reason) {
      return {
        id: 'env02-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: input.model,
        choices: [{ index: 0, delta, finish_reason }]
      }
    }
    const hasAudit = input.tools?.some((item) => item.function.name === 'audit_read_evidence')
    const hasEvidence = input.messages?.some((item) => item.role === 'tool')
    if (hasAudit && !hasEvidence) {
      response.write(
        'data: ' +
          JSON.stringify(
            chunk(
              {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'evidence-1',
                    type: 'function',
                    function: { name: 'audit_read_evidence', arguments: '{}' }
                  }
                ]
              },
              null
            )
          ) +
          '\n\n'
      )
      response.write('data: ' + JSON.stringify(chunk({}, 'tool_calls')) + '\n\n')
    } else {
      response.write(
        'data: ' +
          JSON.stringify(
            chunk(
              {
                role: 'assistant',
                content: hasAudit
                  ? '本机测试：已读取样例证据，尚未进行正式漏洞判断。'
                  : '本机测试回复'
              },
              null
            )
          ) +
          '\n\n'
      )
      response.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n')
    }
    response.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const directory = resolve('.env02-test-data', randomUUID())
  await mkdir(directory, { recursive: true })
  const projectRoot = resolve(directory, 'project')
  await mkdir(projectRoot)
  await writeFile(
    resolve(projectRoot, 'Demo.java'),
    'class Demo {\n  String echo(String input) { return input; }\n}\n'
  )
  await writeFile(resolve(directory, 'outside.java'), 'class Outside {}')
  const config = {
    id: 'model-test',
    revision: 1,
    name: '本机测试配置',
    api: 'openai-completions',
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    modelId: 'fixture-model',
    secretRef: 'test-secret'
  }
  const ports = {
    getConfig: async (id) => (id === config.id ? { ...config } : undefined),
    readSecret: async (reference) =>
      reference === config.secretRef ? 'fixture-key-not-a-real-secret' : undefined
  }
  return {
    directory,
    projectRoot,
    config,
    ports,
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  }
}
