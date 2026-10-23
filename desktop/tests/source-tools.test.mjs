import test from 'node:test'
import assert from 'node:assert/strict'
import { command } from '../src/service/sources/process.ts'
import { detectTool, detectTools } from '../src/service/sources/tools.ts'
test('real Git/rg probe and explicit missing executable; detection installs nothing', async () => {
  const state = await detectTools()
  assert.equal(state.git.state, 'available')
  assert.match(state.git.version, /^git version /)
  assert.equal((await detectTool('pi-source-tool-does-not-exist-71045')).state, 'missing')
})
test('argument arrays preserve shell metacharacters; command timeout and cancellation', async () => {
  const value = 'text & echo injected; $(noop)'
  assert.equal(
    await command(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]),
    value
  )
  await assert.rejects(
    command(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 100 }),
    { code: 'SOURCE_COMMAND_TIMEOUT' }
  )
  const ctl = new AbortController()
  ctl.abort()
  await assert.rejects(command('git', ['--version'], { signal: ctl.signal }), {
    code: 'SOURCE_CANCELLED'
  })
})
