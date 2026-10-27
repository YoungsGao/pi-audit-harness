import { createAgentModelFixture } from './agent-model-fixture.mjs'
// Real Pi SDK performs one tool call per step, then one finish response.
export async function createScanModelFixture(mode = 'ui03') {
  return createAgentModelFixture({ delayMs: 600, mode, supportPing: true })
}
