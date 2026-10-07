import { DEFAULT_CURRENCY, type Currency } from '../../domain/finance'

export type WalletRole = 'owner' | 'member'

export interface Wallet {
  id: string
  name: string
  currency: Currency
  mode: 'shared_log'
  role: WalletRole
  createdAt: string
}

/** Shape returned by `wallets` joined to the caller's `wallet_members` row. */
export interface WalletRow {
  id: string
  name: string
  currency: string
  mode: string
  created_at: string
  wallet_members: { role: string }[]
}

export function walletFromRow(r: WalletRow): Wallet {
  return {
    id: r.id,
    name: r.name,
    currency: r.currency as Currency,
    mode: 'shared_log',
    role: r.wallet_members[0]?.role === 'owner' ? 'owner' : 'member',
    createdAt: r.created_at,
  }
}

export { DEFAULT_CURRENCY }

/** Mirrors the DB CHECK (1-50 chars after trim). */
export function parseWalletName(input: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = input.trim()
  if (!name) return { ok: false, error: 'Enter a wallet name.' }
  if (name.length > 50) return { ok: false, error: 'Wallet name must be 50 characters or fewer.' }
  return { ok: true, name }
}
