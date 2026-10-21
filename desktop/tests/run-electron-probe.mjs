import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve('out-pi-probe/main/electron-pi-probe.js')], {
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timer = setTimeout(() => {
  child.kill()
  process.exitCode = 2
}, 30000)
child.once('exit', (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
