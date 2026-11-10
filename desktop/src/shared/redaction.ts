// Exact credential matching is bounded to values the service actually resolved.
// Pattern redaction also protects imported text; it is not a universal secret scanner.
function credentialForms(secret: string): string[] {
  if (!secret) return []
  let encoded = secret
  try {
    encoded = encodeURIComponent(secret)
  } catch {
    /* Invalid UTF-16 must still be redacted literally. */
  }
  return [...new Set([secret, JSON.stringify(secret).slice(1, -1), encoded])]
}
export function redactKnownCredentials(text: string, secrets: readonly string[] = []): string {
  for (const secret of secrets)
    for (const form of credentialForms(secret)) text = text.split(form).join('[REDACTED]')
  return text
}
export function containsKnownCredential(value: unknown, secrets: readonly string[]): boolean {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return (
    !!text && secrets.some((secret) => credentialForms(secret).some((form) => text.includes(form)))
  )
}
export function redactText(text: string, secrets: readonly string[] = []): string {
  return redactKnownCredentials(text, secrets)
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(
      /((?:api[_-]?key|password|authorization|secret|(?:access[_-]?|refresh[_-]?)?token)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi,
      '$1[REDACTED]'
    )
}
