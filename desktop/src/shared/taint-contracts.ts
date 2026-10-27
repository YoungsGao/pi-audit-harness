export const propagationChecks = [
  'source',
  'argumentMapping',
  'assignment',
  'returnValue',
  'field',
  'defense'
] as const
export type CheckName = (typeof propagationChecks)[number]
export interface TaintValue {
  name: string
  origin: string
  quotes: string[]
  fromStep?: number
}
export interface PropagationCheck {
  status: 'supported' | 'blocked' | 'unknown' | 'not_applicable'
  reason: string
  quotes: string[]
}
export interface TaintReview {
  taintIn: TaintValue[]
  taintOut: TaintValue[]
  checks: Record<CheckName, PropagationCheck>
}
