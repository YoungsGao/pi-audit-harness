import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDetailSelection,
  pathOutcome,
  publicAnalysisText,
  publicAnalysisValue,
  savedEvidence
} from '../src/shared/path-detail-view.ts'

test('detail selection remembers only scoped identifiers and a known tab; damaged or sensitive payloads are ignored', () => {
  const choice = { projectId: 'project-1', runId: 'run-2', pathId: 'path-3', tab: 'process' }
  assert.deepEqual(parseDetailSelection(JSON.stringify(choice)), choice)
  for (const raw of [
    null,
    '{broken',
    '{}',
    JSON.stringify({ ...choice, tab: 'secret' }),
    JSON.stringify({ ...choice, projectId: '../other' }),
    JSON.stringify({ ...choice, apiKey: 'fixture-only-secret' }),
    'x'.repeat(601)
  ])
    assert.equal(parseDetailSelection(raw), null)
})

test('pending, running and failed paths cannot inherit a safety label from older saved evidence', () => {
  assert.equal(pathOutcome({ status: 'pending', verdict: 'safe' }), '未分析')
  assert.match(pathOutcome({ status: 'analyzing', verdict: 'safe' }), /待确认/)
  assert.match(pathOutcome({ status: 'failed', verdict: 'safe' }), /失败.*未知/)
  assert.match(pathOutcome({ status: 'completed', verdict: 'safe' }), /阻断/)
  assert.match(pathOutcome({ status: 'completed', verdict: 'dangerous' }), /风险/)
  assert.match(pathOutcome({ status: 'unresolved', verdict: 'unknown' }), /证据不足/)
})

test('public detail output redacts nested keys, bearer strings, URL credentials and quoted key assignments without changing source records', () => {
  const source = {
    apiKey: 'fixture-key',
    output: [
      {
        Authorization: 'fixture-auth',
        text: 'Bearer fixture-bearer https://user:fixture-password@example.test "api_key": "fixture-inline" sk-fixtureSecret123'
      }
    ]
  }
  const shown = JSON.stringify(publicAnalysisValue(source))
  for (const secret of [
    'fixture-key',
    'fixture-auth',
    'fixture-bearer',
    'fixture-password',
    'fixture-inline',
    'sk-fixtureSecret123'
  ])
    assert.equal(shown.includes(secret), false)
  assert.equal(source.apiKey, 'fixture-key')
  assert.equal(publicAnalysisText('<script>fixture-only</script>'), '<script>fixture-only</script>') // React renders text, never HTML.
})

test('source evidence requires a saved quote and a valid location; missing records are never reconstructed', () => {
  const quote = { filePath: 'Demo.java', startLine: 8, endLine: 11, quote: 'return input;' }
  assert.deepEqual(
    savedEvidence([
      quote,
      null,
      { ...quote, startLine: 0 },
      { ...quote, endLine: 7 },
      { ...quote, quote: '' }
    ]),
    [quote]
  )
  assert.deepEqual(savedEvidence(null), [])
  assert.deepEqual(savedEvidence([{ text: 'invented snippet' }]), [])
})
