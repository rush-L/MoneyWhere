import type { SupabaseClient } from '@supabase/supabase-js'
import { classifyFailure } from '../offline/sync/errors'

/**
 * Message is always safe to show. `outcomeUnknown`: the request may have reached the server before the connection
 * failed, so the account may already be deleted (the call is idempotent; signing in again settles it).
 */
export class DeletionError extends Error {
  constructor(message: string, readonly outcomeUnknown = false) {
    super(message)
  }
}

export interface PlannedWallet { id: string; name: string }
export interface BlockingWallet extends PlannedWallet { otherMembers: number }
/** What deleting the signed-in account would do, as computed by the database (never by the client). */
export interface DeletionPlan {
  /** Owner of a wallet that has other members: deletion is refused until these are resolved. */
  blocking: BlockingWallet[]
  /** Owner and only member: deleted with the account, with everything in it. */
  willDelete: PlannedWallet[]
  /** Plain member: membership ends, the wallet and its history stay (the user's identity is removed from them). */
  leaving: PlannedWallet[]
}
export type DeleteResult = { ok: true } | { ok: false; reason: 'blocked'; wallets: BlockingWallet[] } | { ok: false; reason: 'changed' }

const wallet = (w: unknown): PlannedWallet => {
  const o = w as { id?: unknown; name?: unknown }
  if (typeof o?.id !== 'string' || typeof o.name !== 'string') throw new TypeError('unexpected wallet shape')
  return { id: o.id, name: o.name }
}
const blocking = (w: unknown): BlockingWallet => ({ ...wallet(w), otherMembers: Number((w as { other_members?: unknown }).other_members) || 0 })
const list = <T>(v: unknown, f: (x: unknown) => T): T[] => {
  if (!Array.isArray(v)) throw new TypeError('expected a list')
  return v.map(f)
}

/** Validates the RPC answer; anything unexpected is an error, never a guess. */
export function parsePlan(raw: unknown): DeletionPlan {
  const r = raw as { blocking?: unknown; will_delete?: unknown; leaving?: unknown }
  return { blocking: list(r?.blocking, blocking), willDelete: list(r?.will_delete, wallet), leaving: list(r?.leaving, wallet) }
}

function fail(err: { code?: string; message?: string; status?: number }, what: 'preview' | 'delete'): never {
  console.error('[account-deletion]', err.code, err.message) // code and message only, never the request
  if (err.code === '28000') throw new DeletionError('Your session has expired. Please sign in again.')
  if (classifyFailure(err) === 'network') throw new DeletionError('Could not reach the server. Check your connection and try again.', what === 'delete')
  throw new DeletionError(what === 'delete' ? 'Could not delete your account. Nothing was deleted. Please try again.' : 'Could not check your account. Please try again.')
}

/** Online only. The caller is whoever the session says; no user id is ever sent. */
export function createDeletionService(client: SupabaseClient) {
  return {
    async preview(): Promise<DeletionPlan> {
      const { data, error } = await client.rpc('account_deletion_preview')
      if (error) fail(error, 'preview')
      try {
        return parsePlan(data)
      } catch (e) {
        console.error('[account-deletion]', e)
        throw new DeletionError('Could not check your account. Please try again.')
      }
    },
    /** `confirmed` = the wallets the user was shown as "will be deleted". The server recomputes the set and refuses a mismatch. */
    async deleteAccount(confirmed: readonly string[]): Promise<DeleteResult> {
      const { data, error } = await client.rpc('delete_my_account', { p_confirmed_wallet_ids: [...confirmed] })
      if (error) fail(error, 'delete')
      const r = data as { ok?: unknown; reason?: unknown; wallets?: unknown } | null
      if (r?.ok === true) return { ok: true }
      if (r?.reason === 'blocked') {
        try {
          return { ok: false, reason: 'blocked', wallets: list(r.wallets, blocking) }
        } catch {
          return { ok: false, reason: 'blocked', wallets: [] }
        }
      }
      if (r?.reason === 'changed') return { ok: false, reason: 'changed' }
      throw new DeletionError('Could not delete your account. Please try again.')
    },
  }
}

export type DeletionService = ReturnType<typeof createDeletionService>
