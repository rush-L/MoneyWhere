import type { SupabaseClient } from '@supabase/supabase-js'
import { accountFromSummary, accountUpdatePatch, type Account, type AccountSummaryRow, type NewAccount } from './account'

/** Message is always safe to show to the user. */
export class AccountError extends Error {}

function fail(message: string, err: unknown): never {
  console.error('[accounts]', err)
  throw new AccountError(message)
}

export function createAccountService(client: SupabaseClient) {
  return {
    /** Balances come from the SQL aggregate (no transaction history is downloaded). It runs as the caller, so RLS applies. */
    async list(walletId: string): Promise<Account[]> {
      const { data, error } = await client.rpc('account_summaries', { p_wallet_id: walletId })
      if (error) fail('Could not load accounts. Please try again.', error)
      return (data as AccountSummaryRow[]).map(accountFromSummary)
    },
    /** Currency is not sent: the database derives it from the wallet. */
    async create(walletId: string, a: NewAccount): Promise<void> {
      const { error } = await client.from('accounts').insert({
        id: crypto.randomUUID(),
        wallet_id: walletId,
        name: a.name,
        type: a.type,
        opening_balance_minor: a.openingBalanceMinor,
        holder: a.holder,
      })
      if (error) fail('Could not create the account. Please try again.', error)
    },
    /** RLS hides rows from non-owners, so "no row updated" is reported as a permission problem. */
    async update(a: Account, v: NewAccount): Promise<void> {
      const { data, error } = await client.from('accounts').update(accountUpdatePatch(a, v)).eq('id', a.id).select('id')
      if (error) fail('Could not save the account. Its type and opening balance cannot change once it has transactions.', error)
      if (data.length === 0) fail('Could not save the account. Only the wallet owner can edit it.', 'no rows updated')
    },
    async remove(a: Account): Promise<void> {
      const { data, error } = await client.from('accounts').delete().eq('id', a.id).select('id')
      if (error) fail('Could not delete the account. Please try again.', error)
      if (data.length === 0) fail('Could not delete the account. It may have transactions, or you are not the wallet owner.', 'no rows deleted')
    },
  }
}
