import type { CallEdgeInput } from '../../shared/call-chain-contracts.ts'
import { builtinRules } from '../rules/builtin.ts'
import type { ReviewInput } from './path-analysis.ts'

// A narrow host fact: the rule's risk arguments are literal expressions at the
// exact frozen locations. This does not claim general constant propagation,
// business authorization, runtime type binding, or safety of the whole method.
export function constantRiskArguments(
  edge: CallEdgeInput,
  evidence: ReviewInput['evidence'][number]
): boolean {
  if (!edge.isSink) return false
  const rule = builtinRules.rules.find((r) => r.id === edge.ruleId)
  if (!rule) return false
  const args =
    rule.argumentIndexes === 'all'
      ? edge.arguments
      : rule.argumentIndexes.map((index) => edge.arguments.find((a) => a.index === index))
  if (!args.length || args.some((a) => !a)) return false
  const literal = '"(?:[^"\\\\\r\n]|\\\\[^u\r\n])*"'
  const stringLiteral = new RegExp('^' + literal + '$')
  const fixedPath = new RegExp(
    '^(?:(?:java\\.nio\\.file\\.)?(?:Path\\.of|Paths\\.get))\\(\\s*' +
      literal +
      '(?:\\s*,\\s*' +
      literal +
      ')*\\s*\\)$'
  )
  return args.every((arg) => {
    if (!arg) return false
    const value = arg.text.trim()
    if (
      !stringLiteral.test(value) &&
      !(rule.category === 'path-traversal' && fixedPath.test(value))
    )
      return false
    return (evidence.ranges ?? [evidence]).some((range) => {
      if (
        range.filePath !== arg.filePath ||
        arg.startLine < range.startLine ||
        arg.endLine > range.endLine
      )
        return false
      const lines = range.text
        .split(/\r?\n/)
        .slice(arg.startLine - range.startLine, arg.endLine - range.startLine + 1)
      if (!lines.length) return false
      const last = lines.length - 1
      lines[last] = lines[last].slice(0, arg.endColumn - 1)
      lines[0] = lines[0].slice(arg.startColumn - 1)
      return lines.join('\n') === arg.text.replaceAll('\r\n', '\n')
    })
  })
}
