export function decodeCards(raw, material) {
  let parsed
  try {
    parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''))
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
  return material.map((item) => {
    const answer = parsed[item.id]
    // Both aliases name this single registered source card. Cross-case IDs are rejected.
    const idValid =
      Array.isArray(answer) && answer.length === 2 && [item.id, 'body'].includes(answer[1])
    const verdictValid = ['dangerous', 'safe', 'unknown'].includes(answer?.[0])
    return {
      caseId: item.id,
      verdict: verdictValid ? answer[0] : null,
      evidenceId: idValid ? answer[1] : null,
      quote: idValid ? item.source.split('\n')[6] : null,
      valid: idValid && verdictValid
    }
  })
}
