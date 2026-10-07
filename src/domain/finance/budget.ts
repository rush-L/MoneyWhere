import { add, assertMinor, sub, type Minor } from './money'
import type { Transaction } from './transaction'

/** Just what rollup needs from a category. */
export interface CategoryRef {
  id: string
  parentId: string | null
}

export interface BudgetStatus {
  budget: Minor
  spent: Minor
  remaining: Minor // negative when over budget
  percentUsed: number // unrounded; 68.75 means 68.75%. Round only for display.
  over: boolean
}

export function calculateBudgetStatus(budget: Minor, spent: Minor): BudgetStatus {
  assertMinor(budget)
  if (budget <= 0) throw new RangeError('Budget must be positive')
  return { budget, spent, remaining: sub(budget, spent), percentUsed: (spent * 100) / budget, over: spent > budget }
}

/**
 * Expense spending per TOP-LEVEL category for one month ("YYYY-MM-01"). A subcategory expense counts toward its
 * parent, a direct top-level expense toward itself; each expense lands in exactly one bucket. Income, transfers
 * and other months are ignored. `txs` must already be one wallet's (Transaction has no wallet_id).
 * Dates are YYYY-MM-DD strings, so the month test is a prefix compare: no Date, no timezone.
 */
export function spendingByBudgetCategory(
  txs: readonly Pick<Transaction, 'type' | 'amount_minor' | 'category_id' | 'date'>[],
  categories: readonly CategoryRef[],
  month: string,
): Map<string, Minor> {
  const parentOf = new Map(categories.map((c) => [c.id, c.parentId]))
  const prefix = month.slice(0, 7)
  const out = new Map<string, Minor>()
  for (const t of txs) {
    if (t.type !== 'expense' || !t.category_id || !t.date.startsWith(prefix)) continue
    if (!parentOf.has(t.category_id)) continue
    const top = parentOf.get(t.category_id) ?? t.category_id
    out.set(top, add(out.get(top) ?? 0, t.amount_minor))
  }
  return out
}

export interface BudgetLine extends BudgetStatus {
  categoryId: string
}

export interface BudgetSummary {
  totalBudgeted: Minor
  /** ALL expense spending in the month (budgeted or not), per spendingByBudgetCategory. */
  totalSpent: Minor
  totalRemaining: Minor // negative when over
  /** Every budget with its status, most urgent first: highest percentUsed (so over-budget first), then larger overage, then id. */
  lines: BudgetLine[]
}

/** Month summary from budgets and the per-category spend map. Reuses calculateBudgetStatus; no second percentage formula. */
export function summarizeBudgets(
  budgets: readonly { categoryId: string; amountMinor: Minor }[],
  spentByCategory: ReadonlyMap<string, Minor>,
): BudgetSummary {
  let totalBudgeted: Minor = 0
  let totalSpent: Minor = 0
  for (const b of budgets) totalBudgeted = add(totalBudgeted, b.amountMinor)
  for (const s of spentByCategory.values()) totalSpent = add(totalSpent, s)
  const lines = budgets
    .map((b) => ({ categoryId: b.categoryId, ...calculateBudgetStatus(b.amountMinor, spentByCategory.get(b.categoryId) ?? 0) }))
    .sort((a, b) => b.percentUsed - a.percentUsed || a.remaining - b.remaining || a.categoryId.localeCompare(b.categoryId))
  return { totalBudgeted, totalSpent, totalRemaining: sub(totalBudgeted, totalSpent), lines }
}
