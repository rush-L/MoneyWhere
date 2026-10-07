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
  }
}

export type WalletService = ReturnType<typeof createWalletService>
