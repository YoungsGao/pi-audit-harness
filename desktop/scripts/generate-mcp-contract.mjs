import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { mcpDefinitions } from '../src/service/mcp/contracts.ts'
import { staticRules } from '../src/service/mcp/static-scanner.ts'
const path = resolve(import.meta.dirname, '../../python/src/pi_audit/audit_mcp/contract.json')
await writeFile(
  path,
  JSON.stringify({ definitions: mcpDefinitions, rules: staticRules }, null, 2) + '\n'
)
console.log('Generated Python standalone MCP contract: ' + path)
