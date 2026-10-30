export interface SourceRange {
  filePath: string
  startLine: number
  endLine: number
  startColumn: number
  endColumn: number
  text: string
}

export interface RiskRule {
  id: string
  category: 'sql-injection' | 'command-injection' | 'path-traversal'
  cwe: string
  apis: readonly string[]
  argumentIndexes: readonly number[] | 'all'
  review: {
    source: string
    propagation: string
    defenses: readonly string[]
    limitations: string
  }
}

export interface RuleCatalog {
  version: string
  language: 'java'
  rules: readonly RiskRule[]
}

export interface RiskCandidate extends SourceRange {
  ruleId: string
  api: string
  resolutionStatus: 'candidate'
  arguments: (SourceRange & { index: number })[]
}

export interface RiskQueryResult {
  projectId: string
  sourceStamp: string
  rulesVersion: string
  candidates: RiskCandidate[]
  truncated: boolean
}

export type CodeQueryAction = 'search' | 'read' | 'risks' | 'query'
