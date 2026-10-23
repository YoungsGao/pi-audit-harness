import { createServer } from 'node:http'
export async function createMod01Fixture({ modelId, key }) {
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const part of req) chunks.push(part)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = {}
    }
    requests.push({
      method: req.method,
      path: req.url,
      model: body.model,
      authorization: req.headers.authorization,
      body
    })
    res.setHeader('Content-Type', 'application/json')
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404)
      res.end('{"error":{"message":"fixture unsupported route"}}')
      return
    }
    if (req.headers.authorization !== 'Bearer ' + key) {
      res.writeHead(401)
      res.end('{"error":{"message":"fixture unauthorized"}}')
      return
    }
    if (body.model !== modelId) {
      res.writeHead(404)
      res.end('{"error":{"message":"fixture exact model required"}}')
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    const chunk = (delta, finish) => ({
      id: 'mod01-fixture',
      object: 'chat.completion.chunk',
      created: 0,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finish }]
    })
    res.write(
      'data: ' +
        JSON.stringify(chunk({ role: 'assistant', content: 'MOD-01 本机受控回复' }, null)) +
        '\n\n'
    )
    res.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n')
    res.end('data: [DONE]\n\n')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    requests,
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
