/**
 * Tiny class name joiner: `cx('a', cond && 'b', undefined)` -> 'a b'.
 */
export type ClassValue = string | number | false | null | undefined

export function cx(...values: ClassValue[]): string {
  let out = ''
  for (let i = 0; i < values.length; i++) {
    const v = values[i]
    if (v === false || v === null || v === undefined || v === '' || v === 0) continue
    out = out ? out + ' ' + v : String(v)
  }
  return out
}

export default cx
