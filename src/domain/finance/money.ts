// Money is an integer count of minor units (PHP: 10050 = ₱100.50). Never use floats.
export type Minor = number
export type Currency = 'PHP'
export const DEFAULT_CURRENCY: Currency = 'PHP'

export function assertMinor(n: number): Minor {
  if (!Number.isSafeInteger(n)) throw new RangeError(`Not a safe integer amount: ${n}`)
  return n
}

export const add = (a: Minor, b: Minor): Minor => assertMinor(assertMinor(a) + assertMinor(b))
export const sub = (a: Minor, b: Minor): Minor => assertMinor(assertMinor(a) - assertMinor(b))

/** "100.50" -> 10050. String-based so no float is ever involved. Max 2 decimals. */
export function parseMinor(s: string): Minor {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim())
  if (!m) throw new SyntaxError(`Invalid amount: "${s}"`)
  const minor = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'))
  return assertMinor(m[1] ? -minor : minor)
}

/** 10050 -> "100.50" (no currency symbol or grouping; UI formats that). */
export function formatMinor(n: Minor): string {
  assertMinor(n)
  const abs = Math.abs(n)
  return `${n < 0 ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}
