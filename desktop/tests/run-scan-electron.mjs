import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import electron from 'electron'
const env = { ...process.env }
const qa04 = process.argv.includes('--qa04')
if (qa04) env.PI_AUDIT_QA04 = '1'
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [resolve('out-scan-test/main/scan-electron-main.js')], {
  env,
  windowsHide: true,
  stdio: 'inherit'
})
const timer = setTimeout(
  () => {
    child.kill()
    process.exitCode = 2
  },
  qa04 ? 180000 : 90000
)
child.once('exit', (code) => {
  clearTimeout(timer)
  process.exitCode = code ?? 1
})
