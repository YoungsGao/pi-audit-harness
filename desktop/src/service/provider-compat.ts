// DeepSeek defaults to thinking on its Chat Completions endpoint. Pi's local thinkingLevel
// alone does not transmit that vendor toggle. This product explicitly uses non-thinking sessions.
export function nonThinkingPayload(baseUrl: string, payload: unknown, jsonObject = false): unknown {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return payload
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'api.deepseek.com' ||
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload)
  )
    return payload
  const clean = { ...payload } as Record<string, unknown>
  delete clean.reasoning_effort
  clean.thinking = { type: 'disabled' }
  if (jsonObject) {
    clean.response_format = { type: 'json_object' }
    clean.temperature = 0
  }
  return clean
}
