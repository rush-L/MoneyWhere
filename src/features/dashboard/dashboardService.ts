import type { SupabaseClient } from '@supabase/supabase-js'
import { createAccountService } from '../accounts/accountService'
import { createBudgetService } from '../budgets/budgetService'
import { createCategoryService } from '../categories/categoryService'
import { createTransactionService } from '../transactions/transactionService'
import type { DashboardInputs } from './dashboard'

/** Message is always safe to show to the user. */
export class DashboardError extends Error {}

type Deps = {
  accounts: Pick<ReturnType<typeof createAccountService>, 'list'>
  categories: Pick<ReturnType<typeof createCategoryService>, 'list'>
  budgets: Pick<ReturnType<typeof createBudgetService>, 'list' | 'spending'>
  transactions: Pick<ReturnType<typeof createTransactionService>, 'existingIds'>
}

/**
 * Orchestrates the existing services; all reads use the user's session so RLS applies. All-or-nothing:
 * a partial result would show wrong totals. Returns the server baseline only (the page projects pending local
 * items on top, see `projectDashboard`). `pendingIds` = this wallet's unsynced outbox ids: the one extra query
 * finds which of them the server already counted. Account balances come from the server-side `account_summaries`
 * aggregate (no transaction history fetched).
 */
export function createDashboardService(d: Deps) {
  return {
    async load(walletId: string, month: string, pendingIds: readonly string[] = []): Promise<DashboardInputs> {
      try {
        const [accounts, categories, budgets, spend, confirmed] = await Promise.all([
          d.accounts.list(walletId),
          d.categories.list(walletId),
          d.budgets.list(walletId, month),
          d.budgets.spending(walletId, month),
          d.transactions.existingIds(pendingIds),
        ])
        return { month, accounts, budgets, spend, categories, confirmed }
      } catch (e) {
        console.error('[dashboard]', e)
        throw new DashboardError("We couldn't load your financial summary. Please try again.")
      }
    },
  }
}

export const createDashboardServiceFor = (c: SupabaseClient) =>
  createDashboardService({
    accounts: createAccountService(c),
    categories: createCategoryService(c),
    budgets: createBudgetService(c),
    transactions: createTransactionService(c),
  })
