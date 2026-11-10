import { ResultValidationError } from './result-validation.ts'

// Some compatible streaming endpoints return a complete value but omit a closing
// bracket. Only insert unambiguous structural closers. Never alter strings/values,
// invent fields, remove characters, repair commas, or accept duplicate object keys.
export function parseDecision(text: string): {
  decision: unknown
  repairs: { offset: number; insert: string }[]
} {
  const raw = text.replace(/^```(?:json)?\s*|\s*```$/g, '').trim()
  const stack: { kind: string; keys: Set<string> }[] = [],
    repairs: { offset: number; insert: string }[] = []
  let output = '',
    inString = false,
    escaped = false,
    stringStart = 0
  const fail = (rule: string, message: string): never => {
    throw new ResultValidationError('AGENT_DECISION_INVALID', 'decision', rule, message)
  }
  const close = (offset: number): void => {
    if (repairs.length >= 8) fail('json', 'JSON闭合符号缺失过多，请重新提交完整JSON')
    const insert = stack.pop()!.kind === '{' ? '}' : ']'
    repairs.push({ offset, insert })
    output += insert
  }
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (inString) {
      output += c
      if (escaped) {
        escaped = false
        continue
      }
      if (c === '\\') {
        escaped = true
        continue
      }
      if (c === '"') {
        inString = false
        let next = i + 1
        while (/\s/.test(raw[next] ?? '') && next < raw.length) next++
        if (raw[next] === ':' && stack.at(-1)?.kind === '{') {
          let key: string
          try {
            key = JSON.parse(raw.slice(stringStart, i + 1))
          } catch {
            return fail('json', 'JSON字符串转义无效，请重新提交完整JSON')
          }
          const keys = stack.at(-1)!.keys
          if (keys.has(key))
            fail('duplicate-key', 'JSON对象含重复字段，不能采用覆盖值；请重新提交唯一字段')
          keys.add(key)
        }
      }
      continue
    }
    if (c === '"') {
      inString = true
      stringStart = i
      output += c
      continue
    }
    if (c === '{' || c === '[') stack.push({ kind: c, keys: new Set() })
    else if (c === '}' || c === ']') {
      const expected = c === '}' ? '{' : '['
      if (!stack.some((s) => s.kind === expected))
        fail('json', 'JSON存在多余闭合符号，请重新提交完整JSON')
      while (stack.at(-1)!.kind !== expected) close(i)
      stack.pop()
    }
    output += c
  }
  if (inString) fail('json', 'JSON字符串未闭合；不能补造文本，请重新提交完整JSON')
  while (stack.length) close(raw.length)
  try {
    return { decision: JSON.parse(output), repairs }
  } catch {
    return fail('json', 'JSON语法无效；请检查逗号、转义和完整对象，不要输出JSON以外的文字')
  }
}
