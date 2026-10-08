import { add, monthlyIncome, summarizeBudgets, spendingByBudgetCategory, type BudgetLine, type Minor } from '../../domain/finance'
import type { Account } from '../accounts/account'
import type { Budget } from '../budgets/budget'
import type { SpendRow } from '../budgets/budgetService'
import type { Category } from '../categories/category'
import type { Wallet } from '../wallets/wallet'

export const ATTENTION_COUNT = 3

export interface DashboardData {
  month: string
  accountCount: number
  totalBalance: Minor
  totalBudgeted: Minor
  /** Every expense in the month, budgeted or not. */
  totalSpent: Minor
  /** The part of totalSpent in categories that have a budget. */
  budgetedSpent: Minor
  /** All income in the month; transfers never count. */
  monthlyIncome: Minor
  totalRemaining: Minor
  budgetCount: number
  attention: (BudgetLine & { name: string })[]
}

/** Server baseline for one wallet-month. `confirmed`: unsynced outbox ids the server already has (counted once). */
export interface DashboardInputs {
  month: string
  accounts: readonly Account[]
  budgets: readonly Budget[]
  spend: readonly SpendRow[]
  /** Month's income rows. Optional only so snapshots cached before this field existed still load (they revalidate). */
  income?: readonly SpendRow[]
  categories: readonly Category[]
  confirmed: readonly string[]
}

/** Pure projection of already-loaded data; every number comes from the finance domain. */
export function buildDashboard(i: Omit<DashboardInputs, 'confirmed'>): DashboardData {
  // `spend` may hold expense, income and transfer rows (after the pending projection): each domain function keeps only its own type.
  const sum = summarizeBudgets(i.budgets, spendingByBudgetCategory(i.spend, i.categories, i.month))
  const nameOf = new Map(i.categories.map((c) => [c.id, c.name]))
  return {
    month: i.month,
    accountCount: i.accounts.length,
    totalBalance: i.accounts.reduce((t, a) => add(t, a.currentBalanceMinor), 0),
    totalBudgeted: sum.totalBudgeted,
    totalSpent: sum.totalSpent,
    budgetedSpent: sum.budgetedSpent,
    monthlyIncome: monthlyIncome([...i.spend, ...(i.income ?? [])], i.month),
    totalRemaining: sum.totalRemaining,
    budgetCount: sum.lines.length,
    attention: sum.lines.slice(0, ATTENTION_COUNT).map((l) => ({ ...l, name: nameOf.get(l.categoryId) ?? 'Category' })),
  }
}

/** Saved wallet if still present, else the first; null when there are none. */
export const pickWallet = (wallets: readonly Wallet[], savedId: string | null): Wallet | null =>
  wallets.find((w) => w.id === savedId) ?? wallets[0] ?? null
