const parts = (d: Date, timeZone?: string) =>
  Object.fromEntries(new Intl.DateTimeFormat('en-PH', { day: 'numeric', month: 'short', year: 'numeric', ...(timeZone ? { timeZone } : {}) }).formatToParts(d).map((p) => [p.type, p.value]))

/**
 * "12 Nov 2026" for a date shown to the user. en-PH supplies the month name; the day-first order is assembled here
 * because en-PH's own order is month-first. Display only.
 *
 * - A plain calendar date ("2026-11-12") is a day, not a moment: it is read in UTC and never shifts with the viewer's time zone.
 * - A timestamp (an ISO instant such as a joined-at or expiry time) is shown as the calendar day it falls on in `timeZone`,
 *   by default the viewer's own, so "joined today" reads as today. Pass a zone to make that explicit (tests do).
 * - Missing or unparseable input gives "—", never a made-up date.
 */
export function formatDate(input: string | null | undefined, timeZone?: string): string {
  if (!input) return '—'
  const plain = /^\d{4}-\d{2}-\d{2}$/.test(input)
  const d = new Date(plain ? `${input}T00:00:00Z` : input)
  if (Number.isNaN(d.getTime())) return '—'
  const p = parts(d, plain ? 'UTC' : timeZone)
  return `${p.day} ${p.month} ${p.year}`
}
