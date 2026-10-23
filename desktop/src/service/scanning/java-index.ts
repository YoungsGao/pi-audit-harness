import { lexAndParse } from 'java-parser'
import type { CstNode, IToken } from 'java-parser'
import type { ScanWarning } from '../../shared/scan-contracts'

export interface JavaMethod {
  key: string
  owner: string
  name: string
  types: string[]
  filePath: string
  start: number
  end: number
  bodyStart: number
  line: number
  entry: boolean
  bindings: { name: string; type: string; start: number; end: number }[]
}
export interface JavaCall {
  caller: JavaMethod
  target: JavaMethod | null
  name: string
  receiver: string
  arity: number
  start: number
  open: number
  end: number
  line: number
  column: number
  filePath: string
}
export interface JavaFileIndex {
  methods: JavaMethod[]
  calls: JavaCall[]
  warnings: ScanWarning[]
}
const nodes = (node: CstNode): CstNode[] =>
  Object.values(node.children)
    .flat()
    .filter((x) => 'children' in x) as CstNode[]
function descendants(node: CstNode, name: string): CstNode[] {
  const result: CstNode[] = []
  const visit = (current: CstNode): void => {
    if (current.name === name) result.push(current)
    else for (const child of nodes(current)) visit(child)
  }
  visit(node)
  return result
}
const snippet = (node: CstNode, source: string): string =>
  source.slice(node.location.startOffset, node.location.endOffset + 1)
const identifier = (node: CstNode | undefined): string =>
  node ? String((node.children.Identifier?.[0] as IToken | undefined)?.image ?? '') : ''

// CST 用于真实语法范围；目标匹配只是有边界的候选解析，不冒充编译器类型绑定。
export function indexJavaFile(filePath: string, source: string): JavaFileIndex {
  const { cst, tokens } = lexAndParse(source)
  const methods: JavaMethod[] = [],
    warnings: ScanWarning[] = [],
    fields = new Map<string, JavaMethod['bindings']>()
  const packageNode = descendants(cst, 'packageDeclaration')[0]
  const packageName = packageNode
    ? snippet(packageNode, source)
        .replace(/^package\s+|\s*;$/g, '')
        .trim()
    : ''
  const walk = (node: CstNode, owner: string): void => {
    if (
      [
        'normalClassDeclaration',
        'normalInterfaceDeclaration',
        'recordDeclaration',
        'enumDeclaration'
      ].includes(node.name)
    ) {
      const typeNode = nodes(node).find((child) => child.name === 'typeIdentifier')
      const name = typeNode ? snippet(typeNode, source) : '<anonymous>'
      owner = owner ? owner + '$' + name : [packageName, name].filter(Boolean).join('.')
    }
    if (node.name === 'fieldDeclaration') {
      const typeNode = descendants(node, 'unannType')[0]
      if (typeNode) {
        const current = fields.get(owner) ?? []
        for (const id of descendants(node, 'variableDeclaratorId'))
          current.push({
            name: identifier(id),
            type: snippet(typeNode, source),
            start: 0,
            end: source.length
          })
        fields.set(owner, current)
      }
    }
    if (node.name === 'methodDeclaration' || node.name === 'constructorDeclaration') {
      const declaration = descendants(
        node,
        node.name === 'methodDeclaration' ? 'methodDeclarator' : 'constructorDeclarator'
      )[0]
      const body = descendants(
        node,
        node.name === 'methodDeclaration' ? 'methodBody' : 'constructorBody'
      )[0]
      if (!declaration || !body) return
      const params = descendants(declaration, 'formalParameter')
      const bindings: JavaMethod['bindings'] = []
      const types: string[] = []
      for (const param of params) {
        const id = descendants(param, 'variableDeclaratorId')[0],
          typeNode = descendants(param, 'unannType')[0]
        if (!id || !typeNode) continue
        const type = snippet(typeNode, source).replace(/\s+/g, '')
        types.push(type)
        bindings.push({
          name: identifier(id),
          type,
          start: node.location.startOffset,
          end: node.location.endOffset
        })
      }
      const name = identifier(declaration) || owner.split('.').at(-1)!
      const method: JavaMethod = {
        key: `${owner}#${name}(${types.join(',')})@${filePath}:${node.location.startLine}`,
        owner,
        name,
        types,
        filePath,
        start: node.location.startOffset,
        end: node.location.endOffset,
        bodyStart: body.location.startOffset,
        line: node.location.startLine,
        entry:
          /@(?:[\w$.]+\.)?(?:RequestMapping|GetMapping|PostMapping|PutMapping|PatchMapping|DeleteMapping)\b/.test(
            source.slice(node.location.startOffset, body.location.startOffset)
          ),
        bindings
      }
      const collectLocals = (current: CstNode, scopeEnd: number): void => {
        if (
          current !== node &&
          ['methodDeclaration', 'constructorDeclaration', 'normalClassDeclaration'].includes(
            current.name
          )
        )
          return
        if (current.name === 'block') scopeEnd = current.location.endOffset
        if (current.name === 'localVariableDeclaration') {
          const typeNode = descendants(current, 'unannType')[0]
          if (typeNode)
            for (const id of descendants(current, 'variableDeclaratorId'))
              bindings.push({
                name: identifier(id),
                type: snippet(typeNode, source),
                start: current.location.startOffset,
                end: scopeEnd
              })
        }
        for (const child of nodes(current)) collectLocals(child, scopeEnd)
      }
      collectLocals(body, method.end)
      methods.push(method)
    }
    for (const child of nodes(node)) walk(child, owner)
  }
  walk(cst, '')
  for (const method of methods) method.bindings.unshift(...(fields.get(method.owner) ?? []))
  const closes = new Map<number, number>(),
    stack: number[] = []
  tokens.forEach((token, i) => {
    if (token.image === '(') stack.push(i)
    else if (token.image === ')') {
      const open = stack.pop()
      if (open !== undefined) closes.set(open, i)
    }
  })
  const calls: JavaCall[] = []
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i]
    if (token.tokenType.name !== 'Identifier' || tokens[i + 1].image !== '(') continue
    const caller = methods
      .filter((m) => token.startOffset > m.bodyStart && token.endOffset < m.end)
      .sort((a, b) => a.end - a.start - (b.end - b.start))[0]
    if (!caller) continue
    const close = closes.get(i + 1)
    if (close === undefined) continue
    let arity = close === i + 2 ? 0 : 1,
      depth = 0
    for (let j = i + 2; j < close; j++) {
      if (['(', '[', '{'].includes(tokens[j].image)) depth++
      if ([')', ']', '}'].includes(tokens[j].image)) depth--
      if (tokens[j].image === ',' && depth === 0) arity++
    }
    let receiver = ''
    if (tokens[i - 1]?.image === '.') {
      let j = i - 2
      if (tokens[j]?.image === ')') receiver = '<chained-expression>'
      else {
        receiver = tokens[j]?.image ?? ''
        while (tokens[j - 1]?.image === '.' && /^[\w$]+$/.test(tokens[j - 2]?.image ?? '')) {
          receiver = tokens[j - 2].image + '.' + receiver
          j -= 2
        }
      }
    } else if (tokens[i - 1]?.image === 'new') receiver = '<constructor>'
    calls.push({
      caller,
      target: null,
      name: token.image,
      receiver,
      arity,
      start: token.startOffset,
      open: tokens[i + 1].startOffset,
      end: tokens[close].endOffset + 1,
      line: token.startLine,
      column: token.startColumn,
      filePath
    })
    if (calls.length > 10000 || methods.length > 5000) throw new Error('JAVA_INDEX_LIMIT')
  }
  if (tokens.some((t) => t.image === '::'))
    warnings.push({
      code: 'METHOD_REFERENCE_UNRESOLVED',
      filePath,
      message: '方法引用需要后续语义后端核实。'
    })
  return { methods, calls, warnings }
}

export function resolveCallTargets(methods: JavaMethod[], calls: JavaCall[]): void {
  for (const call of calls) {
    let owner = call.caller.owner
    if (call.receiver && call.receiver !== 'this') {
      const name = call.receiver.replace(/^this\./, '')
      const binding = call.caller.bindings
        .filter(
          (b) =>
            b.name === name &&
            (!call.receiver.startsWith('this.') || b.start === 0) &&
            b.start <= call.start &&
            b.end >= call.end
        )
        .at(-1)
      const type = (binding?.type ?? call.receiver).replace(/<.*>|\[\]|\s/g, '')
      const owners = [
        ...new Set(
          methods
            .filter((m) => m.owner === type || m.owner.endsWith('.' + type))
            .map((m) => m.owner)
        )
      ]
      if (owners.length !== 1) continue
      owner = owners[0]
    }
    const targets = methods.filter(
      (m) => m.owner === owner && m.name === call.name && m.types.length === call.arity
    )
    if (targets.length === 1) call.target = targets[0]
  }
}
