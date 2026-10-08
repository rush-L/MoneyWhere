import type { SupabaseClient } from '@supabase/supabase-js'
import type { Minor, Transaction } from '../../domain/finance'
import { BUDGET_COLUMNS, budgetFromRow, shiftMonth, type Budget, type BudgetRow } from './budget'

/** Message is always safe to show to the user. */
export class BudgetError extends Error {}

function fail(message: string, err: unknown): never {
  console.error('[budgets]', err)
  throw new BudgetError(message)
}

export type SpendRow = Pick<Transaction, 'id' | 'type' | 'amount_minor' | 'category_id' | 'date'>
const PAGE = 1000 // PostgREST's default row cap; a silent cut-off would understate spending

/** One wallet-month of one transaction type, four columns only, filtered and paged by the database. */
async function monthRows(client: SupabaseClient, walletId: string, month: string, type: 'expense' | 'income'): Promise<SpendRow[]> {
  const all: SpendRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client
      .from('transactions')
      .select('id, type, amount_minor, category_id, date')
      .eq('wallet_id', walletId)
      .eq('type', type)
      .gte('date', month)
      .lt('date', shiftMonth(month, 1))
      .order('id')
      .range(from, from + PAGE - 1)
      .returns<SpendRow[]>()
    if (error) fail(type === 'income' ? 'Could not load income. Please try again.' : 'Could not load spending. Please try again.', error)
    all.push(...data)
    if (data.length < PAGE) return all
  }
}

export function createBudgetService(client: SupabaseClient) {
  return {
    /** RLS limits rows to wallets the caller belongs to. */
    async list(walletId: string, month: string): Promise<Budget[]> {
      const { data, error } = await client.from('budgets').select(BUDGET_COLUMNS).eq('wallet_id', walletId).eq('month', month).returns<BudgetRow[]>()
      if (error) fail('Could not load budgets. Please try again.', error)
      return data.map(budgetFromRow)
    },
    /**
     * Expenses of one wallet in one month, four columns only, filtered by the database (never the whole history).
     * ponytail: rolled up client-side by spendingByBudgetCategory; move to a SQL aggregate when a month's expense
     * rows get large.
     */
    async spending(walletId: string, month: string): Promise<SpendRow[]> {
      return monthRows(client, walletId, month, 'expense')
    },
    /** Income of one wallet in one month (Dashboard Monthly Income). Same columns and paging as spending. */
    async income(walletId: string, month: string): Promise<SpendRow[]> {
      return monthRows(client, walletId, month, 'income')
    },
    async create(walletId: string, b: { category_id: string; month: string; amount_minor: Minor }): Promise<void> {
      const { error } = await client.from('budgets').insert({ id: crypto.randomUUID(), wallet_id: walletId, ...b })
      if (error) fail(error.code === '23505' ? 'A budget for that category and month already exists.' : 'Could not create the budget. Please try again.', error)
    },
    /** Only the amount can change. RLS hides rows from non-owners, so "no row updated" means no permission. */
    async updateAmount(id: string, amount_minor: Minor): Promise<void> {
      const { data, error } = await client.from('budgets').update({ amount_minor }).eq('id', id).select('id')
      if (error) fail('Could not save the budget. Please try again.', error)
      if (data.length === 0) fail('Could not save the budget. Only the wallet owner can edit it.', 'no rows updated')
    },
    async remove(id: string): Promise<void> {
      const { data, error } = await client.from('budgets').delete().eq('id', id).select('id')
      if (error) fail('Could not delete the budget. Please try again.', error)
      if (data.length === 0) fail('Could not delete the budget. Only the wallet owner can delete it.', 'no rows deleted')
    },
  }
}
