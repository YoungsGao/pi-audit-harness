// Portable snapshot paths: no drive/ADS, traversal, Windows device names or graph configuration directories.
export function isSnapshotPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1000 &&
    !/[\\:<>"|?*]/.test(value) &&
    !Array.from(value).some((character) => character.charCodeAt(0) < 32) &&
    !value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          part.toLowerCase() === '.codegraph' ||
          /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
      )
  )
}
export function isSnapshotJavaPath(value: unknown): value is string {
  return isSnapshotPath(value) && /\.java$/i.test(value)
}
