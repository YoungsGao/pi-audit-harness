import { loadPiSdk } from '../src/service/pi-adapter.ts'

const sdk = await loadPiSdk()
if (
  typeof sdk.createAgentSession !== 'function' ||
  typeof sdk.ModelRuntime?.create !== 'function'
) {
  throw new Error('Pi SDK 导出不符合当前基线')
}
console.log('PASS: Node 可以加载 Pi SDK；没有发送模型请求。')
