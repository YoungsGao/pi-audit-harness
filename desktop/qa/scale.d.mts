export function generateScale(
  source: string,
  physicalLines?: number,
  candidates?: number
): Promise<{ physicalLines: number; candidates: number; files: number; construction: string }>
export function generateLongPath(source: string): Promise<void>
