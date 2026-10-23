import { createServer } from 'node:http'

const host = '127.0.0.1'
const port = 3210

const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8')

  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200)
    response.end(
      JSON.stringify({
        ok: true,
        service: 'pi-audit-local',
        stage: 'http-ready'
      })
    )
    return
  }

  response.writeHead(404)
  response.end(
    JSON.stringify({
      ok: false,
      code: 'NOT_FOUND',
      message: '接口不存在'
    })
  )
})

server.on('error', (error) => {
  console.error('服务启动失败：', error.message)
  process.exitCode = 1
})

server.listen(port, host, () => {
  console.log(`HTTP 服务已启动：http://${host}:${port}/health`)
})

function shutdown(): void {
  server.close(() => console.log('HTTP 服务已关闭'))
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
