import { resolve } from 'node:path'
import { pythonResources } from '../src/service/mcp/manager.ts'
const json = JSON.stringify(
  {
    mcpServers: {
      本地计算器: {
        command: pythonResources().python,
        args: ['-u', resolve(import.meta.dirname, '../../python/tests/fixtures/calculator_mcp.py')]
      }
    }
  },
  null,
  2
)
// Keep JSON intact when PowerShell decodes native stdout using a legacy code page.
console.log(
  json.replace(
    /[\u0080-\uffff]/g,
    (character) => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0')
  )
)
