import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve('out-review-test/main/review-electron-main.js')], {
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timer = setTimeout(() => {
  child.kill()
  process.exitCode = 2
}, 150000)
child.once('exit', (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
