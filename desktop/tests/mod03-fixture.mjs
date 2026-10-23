import { createServer } from 'node:http'
export async function createMod03Fixture({ mode = 'success', delayMs = 0 } = {}) {
  const requests = []
  let active = 0,
    disconnects = 0
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString())
    } catch {
      body = {}
    }
    requests.push({
      method: req.method,
      path: req.url,
      authorization: req.headers.authorization,
      body
    })
    active++
    res.once('close', () => {
      active--
      if (!res.writableEnded) disconnects++
    })
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    if (mode === 'network') {
      req.socket.destroy()
      return
    }
    if (mode === 'timeout') return
    const timer = delayMs ? setTimeout(reply, delayMs) : undefined
    res.once('close', () => clearTimeout(timer))
    if (!delayMs) reply()
    function reply() {
      if (res.destroyed) return
      const statuses = { auth: 401, forbidden: 403, model: 404, quota: 429, server: 503 }
      if (mode in statuses) {
        res.writeHead(statuses[mode], { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: 'fixture-private-error-do-not-echo', type: 'fixture_error' }
          })
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const chunk = (delta, finish) => ({
        id: 'mod03-fixture',
        object: 'chat.completion.chunk',
        created: 0,
        model: body.model,
        choices: [{ index: 0, delta, finish_reason: finish }]
      })
      const content =
        mode === 'empty'
          ? '   '
          : mode === 'large'
            ? 'x'.repeat(17000)
            : 'MOD-03 本机模型已收到 ping，连接可用。<script>fixture</script>'
      res.write('data: ' + JSON.stringify(chunk({ role: 'assistant', content }, null)) + '\n\n')
      res.write('data: ' + JSON.stringify(chunk({}, 'stop')) + '\n\n')
      res.end('data: [DONE]\n\n')
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    requests,
    get active() {
      return active
    },
    get disconnects() {
      return disconnects
    },
    baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
    config: {
      id: 'mod03-fixture',
      revision: 1,
      name: 'MOD03 fixture',
      api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:' + server.address().port + '/v1',
      modelId: 'explicit-fixture-model',
      secretRef: 'fixture-reference'
    },
    async close() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    }
  }
}
