import { assertMinor, parseMinor, type Minor } from '../../domain/finance'

export interface Budget {
  id: string
  walletId: string
  categoryId: string
  month: string // canonical first-of-month date, YYYY-MM-01
  amountMinor: Minor
}

export interface BudgetRow {
  id: string
  wallet_id: string
  category_id: string
  month: string
  amount_minor: number
}

export const BUDGET_COLUMNS = 'id, wallet_id, category_id, month, amount_minor'

export const budgetFromRow = (r: BudgetRow): Budget => ({
  id: r.id, walletId: r.wallet_id, categoryId: r.category_id, month: r.month, amountMinor: r.amount_minor,
})

// Months are "YYYY-MM-01" strings; arithmetic is on the numbers, never on a Date in local time.

export const isMonth = (s: string) => /^\d{4}-(0[1-9]|1[0-2])-01$/.test(s)

/** Current month in the user's local calendar. */
export function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

export function shiftMonth(month: string, by: number): string {
  const idx = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + by
  return `${String(Math.floor(idx / 12)).padStart(4, '0')}-${String((idx % 12) + 1).padStart(2, '0')}-01`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
export const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`

export interface BudgetInput {
  categoryId: string
  month: string // YYYY-MM-01 (the form converts <input type="month"> by appending -01)
  amount: string
}

/** Amount alone (also used by edit). Returns the minor units, or an error message. */
export function parseBudgetAmount(raw: string): Minor | string {
  let n: Minor
  try {
    n = assertMinor(parseMinor(raw.trim()))
  } catch {
    return 'Enter a valid amount, e.g. 8000 or 250.50.'
  }
  return n > 0 ? n : 'Budget must be greater than zero.'
}

/** Mirrors the DB CHECKs. `topLevelIds` limits the category (the DB trigger is the real guard). */
export function parseBudget(
  i: BudgetInput,
  topLevelIds: readonly string[],
): { ok: true; value: { category_id: string; month: string; amount_minor: Minor } } | { ok: false; error: string } {
  if (!topLevelIds.includes(i.categoryId)) return { ok: false, error: 'Choose a top-level category.' }
  if (!isMonth(i.month)) return { ok: false, error: 'Choose the budget month.' }
  const amount_minor = parseBudgetAmount(i.amount)
  if (typeof amount_minor === 'string') return { ok: false, error: amount_minor }
  return { ok: true, value: { category_id: i.categoryId, month: i.month, amount_minor } }
}
