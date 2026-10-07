import { IDBFactory } from 'fake-indexeddb'
import type { SupabaseClient } from '@supabase/supabase-js'
import { openOfflineDb } from './db/idb'
import { createCache } from './db/cache'
import { createOutbox } from './outbox/outbox'
import type { NewTransaction } from '../transactions/transaction'

/** Test helpers only: a fresh in-memory IndexedDB per call. */
export async function freshStores() {
  const db = await openOfflineDb(new IDBFactory(), 'test')
  return { outbox: createOutbox(db), cache: createCache(db) }
}

export const expense = (o: Partial<NewTransaction> = {}): NewTransaction => ({
  type: 'expense', account_id: 'acc1', destination_account_id: null, category_id: 'cat1', amount_minor: 50000, date: '2026-10-10', note: null, ...o,
})
export const queued = (id: string, user_id: string, payload = expense(), wallet_id = 'w1') => ({ id, user_id, wallet_id, payload })

/**
 * Minimal Supabase stand-in for the two calls `transactionService.send` makes. `rows` is the "server" table
 * (id -> creator); `me` is the session user; `visible` says whether RLS shows a row to this user; `down` simulates
 * no network; `loseResponse` commits the insert but drops the reply.
 */
export function fakeServer(me: () => string, opts: { down?: () => boolean; loseResponse?: () => boolean; visible?: (id: string, createdBy: string) => boolean } = {}) {
  const rows = new Map<string, string>()
  const sent: string[] = []
  const offline = { error: { message: 'TypeError: Failed to fetch' }, status: 0 }
  const client = {
    from: () => ({
      insert: async (row: { id: string }) => {
        if (opts.down?.()) return offline
        if (rows.has(row.id)) return { error: { code: '23505', message: 'duplicate key' }, status: 409 }
        rows.set(row.id, me()) // created_by = session user, never client-supplied
        sent.push(row.id)
        if (opts.loseResponse?.()) return offline
        return { error: null, status: 201 }
      },
      select: () => ({
        eq: (_c: string, id: string) => ({
          maybeSingle: async () => {
            if (opts.down?.()) return { data: null, ...offline }
            const by = rows.get(id)
            return { data: by && (opts.visible?.(id, by) ?? true) ? { id, created_by: by } : null, error: null, status: 200 }
          },
        }),
      }),
    }),
  } as unknown as SupabaseClient
  return { rows, sent, client }
}
