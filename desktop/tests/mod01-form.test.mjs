import test from 'node:test'
import assert from 'node:assert/strict'
import { validateModelForm } from '../src/shared/model-form.ts'
import { parseModel } from '../src/service/storage/metadata-validation.ts'
const base = {
  name: ' fixture ',
  baseUrl: 'https://example.invalid/v1/',
  modelId: ' chosen-model '
}
test('controlled form normalizes metadata but never substitutes model ID or credential', () => {
  const { input, errors } = validateModelForm(base, 'fixture-key')
  assert.deepEqual(errors, {})
  assert.equal(input.name, 'fixture')
  assert.equal(input.baseUrl, 'https://example.invalid/v1')
  assert.equal(input.modelId, 'chosen-model')
  assert.equal(input.apiKey, 'fixture-key')
  assert.deepEqual(parseModel(input), {
    ...input,
    configId: undefined,
    expectedRevision: undefined
  })
})
test('blank key omitted, not sent as mask or deletion; update carries saved ID/revision', () => {
  const result = validateModelForm(
    { ...base, configId: 'saved-model', expectedRevision: 4, apiKey: 'fixture-stale-draft-key' },
    ''
  )
  assert.equal('apiKey' in result.input, false)
  assert.equal(result.input.configId, 'saved-model')
  assert.equal(result.input.expectedRevision, 4)
})
test('URL and required-field errors can be displayed beside their respective inputs', () => {
  const invalid = validateModelForm(
    { name: '', baseUrl: 'https://user:fixture@example.invalid?key=x', modelId: '' },
    '\n'
  )
  assert.deepEqual(Object.keys(invalid.errors).sort(), ['apiKey', 'baseUrl', 'modelId', 'name'])
  for (const url of ['javascript:alert(1)', 'https://example.invalid/v1#fragment', '/v1'])
    assert.ok(validateModelForm({ ...base, baseUrl: url }, '').errors.baseUrl)
})
test('key byte limit is UTF-8, not JS character count; invalid form values rejected by backend too', () => {
  const key = '中'.repeat(700)
  assert.ok(validateModelForm(base, key).errors.apiKey)
  assert.throws(() => parseModel({ ...base, apiKey: key }), { code: 'INVALID_METADATA' })
  assert.ok(validateModelForm({ ...base, name: 'bad\nname' }, '').errors.name)
})
