import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve('out-mod03-test/main/mod03-electron-main.js')], {
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timer = setTimeout(() => {
  child.kill()
  process.exitCode = 2
}, 180000)
child.once('exit', (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
