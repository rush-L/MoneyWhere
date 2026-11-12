import { describe, expect, it } from 'vitest'
import { formatDate } from './formatDate'

describe('formatDate', () => {
  it('formats a calendar date as "12 Nov 2026"', () => {
    expect(formatDate('2026-11-12')).toBe('12 Nov 2026')
    expect(formatDate('2026-01-01')).toBe('1 Jan 2026')
    expect(formatDate('2024-02-29')).toBe('29 Feb 2024')
  })
  it('names every month', () => {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    names.forEach((m, i) => expect(formatDate(`2026-${String(i + 1).padStart(2, '0')}-15`)).toBe(`15 ${m} 2026`))
  })
  it('a plain date never shifts with the time zone (it is a day, not a moment)', () => {
    for (const tz of ['UTC', 'Asia/Manila', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) expect(formatDate('2026-11-12', tz)).toBe('12 Nov 2026')
  })
  it('a timestamp is the calendar day it falls on in the given zone', () => {
    const late = '2026-11-12T23:30:00Z' // still the 12th in UTC, already the 13th in Manila (UTC+8)
    expect(formatDate(late, 'UTC')).toBe('12 Nov 2026')
    expect(formatDate(late, 'Asia/Manila')).toBe('13 Nov 2026')
    expect(formatDate(late, 'America/Los_Angeles')).toBe('12 Nov 2026')
    const early = '2026-11-13T01:00:00Z'
    expect(formatDate(early, 'Pacific/Honolulu')).toBe('12 Nov 2026') // 15:00 on the 12th there
  })
  it('honours an explicit offset in the timestamp', () => {
    expect(formatDate('2026-02-01T00:00:00+08:00', 'Asia/Manila')).toBe('1 Feb 2026')
    expect(formatDate('2026-02-01T00:00:00+08:00', 'UTC')).toBe('31 Jan 2026')
  })
  it('handles year boundaries', () => {
    expect(formatDate('2026-12-31T16:00:00Z', 'Asia/Manila')).toBe('1 Jan 2027')
    expect(formatDate('2026-12-31T16:00:00Z', 'UTC')).toBe('31 Dec 2026')
  })
  it('missing or invalid input is a dash, never an invented date', () => {
    for (const bad of [undefined, null, '', 'not a date', '2026-13-45', '12/11/2026x']) expect(formatDate(bad as string | null | undefined)).toBe('—')
  })
})
