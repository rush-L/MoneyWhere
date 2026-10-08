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
  /** normal < 80% used, warning 80% to < 100%, exceeded >= 100% (exactly 100% is exceeded). */
  status: BudgetThreshold
  over: boolean // status === 'exceeded'
}

export type BudgetThreshold = 'normal' | 'warning' | 'exceeded'

/** Exact integer comparison (BigInt), so the 80% / 100% boundaries never depend on float rounding. */
function thresholdOf(budget: Minor, spent: Minor): BudgetThreshold {
  if (spent >= budget) return 'exceeded'
  return BigInt(spent) * 5n >= BigInt(budget) * 4n ? 'warning' : 'normal'
}

export function calculateBudgetStatus(budget: Minor, spent: Minor): BudgetStatus {
  assertMinor(budget)
  if (budget <= 0) throw new RangeError('Budget must be positive')
  const status = thresholdOf(budget, spent)
  return { budget, spent, remaining: sub(budget, spent), percentUsed: (spent * 100) / budget, status, over: status === 'exceeded' }
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

/**
 * Income total for one month ("YYYY-MM-01"). Only income counts: expenses and transfers never do.
 * `txs` must already be one wallet's. Same prefix-compare month test as spendingByBudgetCategory.
 */
export function monthlyIncome(txs: readonly Pick<Transaction, 'type' | 'amount_minor' | 'date'>[], month: string): Minor {
  const prefix = month.slice(0, 7)
  let total: Minor = 0
  for (const t of txs) if (t.type === 'income' && t.date.startsWith(prefix)) total = add(total, t.amount_minor)
  return total
}

export interface BudgetLine extends BudgetStatus {
  categoryId: string
}

export interface BudgetSummary {
  totalBudgeted: Minor
  /** ALL expense spending in the month (budgeted or not), per spendingByBudgetCategory. */
  totalSpent: Minor
  /** The part of totalSpent that falls in categories with a budget (subcategories roll up to their budgeted parent). */
  budgetedSpent: Minor
  /** Budget capacity left: totalBudgeted - budgetedSpent (unbudgeted spending never reduces it). Negative when over. */
  totalRemaining: Minor
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
  let budgetedSpent: Minor = 0
  for (const b of budgets) {
    totalBudgeted = add(totalBudgeted, b.amountMinor)
    budgetedSpent = add(budgetedSpent, spentByCategory.get(b.categoryId) ?? 0)
  }
  for (const s of spentByCategory.values()) totalSpent = add(totalSpent, s)
  const lines = budgets
    .map((b) => ({ categoryId: b.categoryId, ...calculateBudgetStatus(b.amountMinor, spentByCategory.get(b.categoryId) ?? 0) }))
    .sort((a, b) => b.percentUsed - a.percentUsed || a.remaining - b.remaining || a.categoryId.localeCompare(b.categoryId))
  return { totalBudgeted, totalSpent, budgetedSpent, totalRemaining: sub(totalBudgeted, budgetedSpent), lines }
}
