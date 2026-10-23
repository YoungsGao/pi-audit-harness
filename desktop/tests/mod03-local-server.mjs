// 手工学习用本机服务，不是生产后端，也不代理任何真实供应商。
import { createMod03Fixture } from './mod03-fixture.mjs'
const modes = [
  'success',
  'empty',
  'auth',
  'forbidden',
  'model',
  'quota',
  'server',
  'network',
  'timeout'
]
const [flag, mode = 'success', ...extra] = process.argv.slice(2)
if ((flag !== undefined && flag !== '--mode') || !modes.includes(mode) || extra.length)
  throw new Error('Usage: node tests/mod03-local-server.mjs --mode ' + modes.join('|'))
const fixture = await createMod03Fixture({ mode })
console.log('MOD-03 本机教学服务（不连接真实供应商）')
console.log('Base URL:', fixture.baseUrl)
console.log('模型 ID: explicit-fixture-model')
console.log('仅填假 Key: fixture-mod03-local-only')
console.log('场景:', mode, '；timeout 会等待客户端的正式 15 秒期限。')
console.log('每收到一个请求，只打印序号与路径，不打印 Key、正文或项目源码。Ctrl+C 停止。')
let count = 0
const timer = setInterval(() => {
  while (count < fixture.requests.length) {
    const req = fixture.requests[count++]
    console.log('收到请求 #' + count, req.method, req.path)
  }
}, 200)
async function stop() {
  clearInterval(timer)
  await fixture.close()
  process.exit(0)
}
process.once('SIGINT', () => void stop())
process.once('SIGTERM', () => void stop())
