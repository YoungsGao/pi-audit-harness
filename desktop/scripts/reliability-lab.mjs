// Local-only interactive error simulation for the production UI; never reads provider credentials.
import { createInterface } from 'node:readline'
import { createAgentModelFixture } from '../tests/agent-model-fixture.mjs'
const port = Number(process.argv[2] ?? 18767)
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Port must be 1024..65535')
let mode = 'badonce',
  submissions = 0
const model = await createAgentModelFixture({
  port,
  mode: 'finish',
  supportPing: true,
  transformDecision: (decision, { tools }) => {
    submissions++
    const bad = mode === 'bad' || (mode === 'badonce' && submissions === 1)
    for (const step of decision.result.steps)
      step.quotes = [
        bad ? 'ev-invented' : tools.find((t) => t.stepIndex === step.stepIndex).citations[0].id
      ]
    return decision
  }
})
console.log(
  `本机实验模型 ${model.baseUrl}；模型ID fixture；实验假Key local-fixture-key；付费请求0。`
)
console.log(
  '默认badonce：首次提交错误证据ID，随后正确提交。命令 badonce / bad / normal / status / quit。'
)
const input = createInterface({ input: process.stdin, output: process.stdout })
input.on('line', (line) => {
  const command = line.trim().toLowerCase()
  if (['badonce', 'bad', 'normal'].includes(command)) {
    mode = command
    submissions = 0
    console.log('模式=' + mode)
  } else if (command === 'status')
    console.log(
      JSON.stringify({ mode, requests: model.requests.length, submissions, paidRequests: 0 })
    )
  else if (command === 'quit') input.close()
  else console.log('可用命令：badonce / bad / normal / status / quit')
})
input.on('close', () => {
  void model.close()
})
process.once('SIGINT', () => input.close())
