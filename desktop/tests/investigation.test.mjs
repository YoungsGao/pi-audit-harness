import test from 'node:test'
import assert from 'node:assert/strict'
import { InvestigationTracker } from '../src/service/chains/investigation.ts'
import { createAgentHarness } from './agent-harness.mjs'

test('investigation distinguishes material acquisition, candidate discovery and validated submission with idempotent receipts', () => {
  const tracker = new InvestigationTracker(
    { path: { steps: [{ stepIndex: 0 }], truncated: false } },
    ['audit_read_step', 'audit_read_related']
  )
  assert.equal(tracker.snapshot().gaps[0].code, 'SOURCE_READ')
  const complete = {
    type: 'tool',
    status: 'completed',
    toolName: 'audit_read_step',
    payload: {
      input: { stepIndex: 0 },
      output: { text: 'raw', complete: true, citations: [{ id: 'ev-0' }] }
    }
  }
  tracker.accept(complete)
  tracker.accept(complete)
  assert.equal(tracker.snapshot().evidenceBytes, 3)
  assert.equal(tracker.snapshot().phase, 'verifying')
  tracker.accept({
    type: 'tool',
    status: 'completed',
    toolName: 'audit_find_related',
    payload: {
      input: { stepIndex: 0, direction: 'outgoing' },
      output: { items: [{ targetId: 'rel-target' }] }
    }
  })
  assert.equal(tracker.snapshot().gaps[0].code, 'RELATED_REVIEW')
  tracker.accept({
    type: 'tool',
    status: 'completed',
    toolName: 'audit_static_scan',
    payload: { input: { stepIndex: 0 }, output: { status: 'unavailable', items: [] } }
  })
  assert.notEqual(tracker.snapshot().phase, 'verified')
  tracker.accept({ type: 'process', status: 'investigation_verified' })
  assert.equal(tracker.snapshot().phase, 'verified')
  assert.ok(
    tracker.snapshot().gaps.length,
    'a valid unknown submission does not erase outstanding material gaps'
  )
})

test('actual audit saves complete investigation snapshots in the same SSE history and replay needs no additional model request', async (t) => {
  const h = await createAgentHarness(t, 'finish')
  const pathId = h.prepared.pathIds[0]
  await h.chains.action('analyze', { ...h.scope, pathId, modelConfigId: 'model' })
  await h.chains.analysis.waitForIdle()
  const history = await h.chains.action('history', { ...h.scope, pathId })
  const snapshots = history.frames.filter((f) => f.event === 'investigation_info')
  assert.ok(snapshots.length)
  assert.equal(snapshots.at(-1).data.details.payload.phase, 'verified')
  assert.ok(snapshots.at(-1).data.details.payload.steps.every((s) => s.read === 'complete'))
  const requests = h.model.requests.length
  await h.chains.action('history', { ...h.scope, pathId, sessionId: history.selectedSessionId })
  assert.equal(h.model.requests.length, requests)
})
