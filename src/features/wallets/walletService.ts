import type { SupabaseClient } from '@supabase/supabase-js'
import { walletFromRow, type Wallet, type WalletRow } from './wallet'

/** Message is always safe to show to the user. */
export class WalletError extends Error {}

function fail(message: string, err: unknown): never {
  console.error('[wallets]', err)
  throw new WalletError(message)
}

export function createWalletService(client: SupabaseClient) {
  return {
    /** RLS already limits rows to wallets the caller belongs to; the embed returns only their own membership row. */
    async list(userId: string): Promise<Wallet[]> {
      const { data, error } = await client
        .from('wallets')
        .select('id, name, currency, mode, created_at, wallet_members!inner(role)')
        .eq('wallet_members.user_id', userId)
        .order('created_at', { ascending: true })
        .returns<WalletRow[]>()
      if (error) fail('Could not load your wallets. Please try again.', error)
      return data.map(walletFromRow)
    },
    /** Creator becomes owner atomically in the database (create_wallet RPC). */
    async create(name: string): Promise<void> {
      const { error } = await client.rpc('create_wallet', { p_name: name })
      if (error) fail('Could not create the wallet. Please try again.', error)
    },
    /** Owner only, enforced by RLS (column grant `update (name)`); a non-owner matches no row, reported as a permission problem. */
    async rename(walletId: string, name: string): Promise<void> {
      const { data, error } = await client.from('wallets').update({ name }).eq('id', walletId).select('id')
      if (error) fail('Could not rename the wallet. Please try again.', error)
      if (data.length === 0) fail('Could not rename the wallet. Only the wallet owner can rename it.', 'no rows updated')
    },
    /**
     * Owner only, enforced by RLS. Cascades to accounts, categories, budgets, transactions and memberships, for every member.
     * Zero rows means the caller is not the owner or the wallet is already gone: never reported as success.
     */
    async remove(walletId: string): Promise<void> {
      const { data, error } = await client.from('wallets').delete().eq('id', walletId).select('id')
      if (error) fail('Could not delete the wallet. Nothing was deleted. Please try again.', error)
      if (data.length === 0) fail('Could not delete the wallet. Only the wallet owner can delete it, and it may already be deleted.', 'no rows deleted')
    },
  }
}

export type WalletService = ReturnType<typeof createWalletService>
