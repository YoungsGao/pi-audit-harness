import { ApiError } from '../../shared/api-error.ts'
import type { PositionEncoding, QueryPosition } from '../../shared/query-contracts.ts'

export function toLspPosition(
  source: string,
  position: QueryPosition,
  encoding: PositionEncoding
): { line: number; character: number } {
  const line = source.split('\n')[position.line - 1]?.replace(/\r$/, '')
  const offset = position.column - 1
  if (!line || offset < 0 || offset > line.length) {
    if (line !== '' || offset !== 0)
      throw new ApiError('QUERY_INVALID_POSITION', '源码位置超出范围', 400)
  }
  const prefix = (line ?? '').slice(0, offset)
  if (offset > 0 && /[\uD800-\uDBFF]/.test(prefix.at(-1)!))
    throw new ApiError('QUERY_INVALID_POSITION', '位置不能拆开 Unicode 字符', 400)
  return {
    line: position.line - 1,
    character:
      encoding === 'utf-8'
        ? Buffer.byteLength(prefix)
        : encoding === 'utf-32'
          ? [...prefix].length
          : offset
  }
}
export function fromLspPosition(
  source: string,
  position: { line: number; character: number },
  encoding: PositionEncoding
): QueryPosition {
  if (
    !Number.isInteger(position?.line) ||
    !Number.isInteger(position?.character) ||
    position.line < 0 ||
    position.character < 0
  )
    throw new ApiError('QUERY_BACKEND_OUTPUT', '语言服务器位置无效', 502)
  const line = source.split('\n')[position.line]?.replace(/\r$/, '')
  if (line === undefined) throw new ApiError('QUERY_BACKEND_OUTPUT', '语言服务器位置越界', 502)
  let units = 0,
    column = 0
  for (const char of line) {
    if (units === position.character) break
    units +=
      encoding === 'utf-8' ? Buffer.byteLength(char) : encoding === 'utf-32' ? 1 : char.length
    column += char.length
  }
  if (units !== position.character)
    throw new ApiError('QUERY_BACKEND_OUTPUT', '语言服务器位置拆开字符或越界', 502)
  return { line: position.line + 1, column: column + 1 }
}
