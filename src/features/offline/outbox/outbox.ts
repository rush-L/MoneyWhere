import type { NewTransaction, TransactionRow } from '../../transactions/transaction'
import { OUTBOX, committed, request } from '../db/idb'

/**
 * PENDING  queued, not yet sent (also: sent but the network failed, will retry)
 * SYNCING  a sync run is sending it now (reset to PENDING if the tab died mid-flight)
 * SYNCED   acknowledged by the server. Never persisted: the record is deleted on success (see `complete`).
 * FAILED   temporary server-side failure; retried on the next sync trigger
 * BLOCKED  permanent (RLS/constraint rejection, UUID integrity problem, user mismatch); never retried, stays visible
 * CONFLICT a valid UPDATE/DELETE, but the server row changed first (or vanished); never retried, the server's version
 *          is kept, stays visible until the user dismisses it (`discard`)
 */
export type OutboxStatus = 'PENDING' | 'SYNCING' | 'SYNCED' | 'FAILED' | 'BLOCKED' | 'CONFLICT'

export type OutboxOp = 'CREATE' | 'UPDATE' | 'DELETE'

/** The row is not in a state where it can be changed safely (syncing, possibly already sent, or finished with an issue). Message is safe to show. */
export class OutboxBusyError extends Error {}
const busy = (i: OutboxItem) =>
  new OutboxBusyError(
    i.status === 'CONFLICT' || i.status === 'BLOCKED'
      ? 'Dismiss the sync warning on this transaction first.'
      : i.status === 'SYNCING'
        ? 'This transaction is syncing right now. Try again in a moment.'
        : "A sync was already attempted for this transaction, so it can't be changed until the server confirms it. Reconnect and try again once it shows as synced.",
  )

export interface OutboxItem {
  seq: number // creation order
  /**
   * The transaction's UUID: used locally, in IndexedDB and in the Supabase call. Never regenerated. Unique, so there
   * is at most ONE open item per transaction (edits and deletes are folded into it; see `edit` / `remove`).
   * Items saved before Phase 11B have no op/expected_version/mutation_id: they are CREATEs (see `norm`).
   */
  id: string
  op: OutboxOp
  /** UPDATE/DELETE: the server version the user saw. The server applies it only if the row is still at this version. */
  expected_version: number | null
  /** UPDATE/DELETE: the idempotency key for the server's mutation ledger (a replay after a lost response is a no-op). */
  mutation_id: string | null
  /**
   * UPDATE/DELETE: the row as the user last saw it (version included). It is the baseline the item is projected over
   * when the server's row is not at hand (offline), so balances move by exactly (new state - this state).
   */
  base: TransactionRow | null
  /** Owner. Only this user's session may ever send the item. Never trusted from the payload; the DB sets created_by. */
  user_id: string
  wallet_id: string // local grouping only; not sent (the database derives it from the account)
  created_at: string
  status: OutboxStatus
  attempt_count: number
  last_error: string | null
  payload: NewTransaction | null // null for DELETE; no created_by, no tokens, no session
}

export type NewOutboxItem = Pick<OutboxItem, 'id' | 'user_id' | 'wallet_id'> & { payload: NewTransaction }

const norm = (i: OutboxItem): OutboxItem => ({ ...i, op: i.op ?? 'CREATE', expected_version: i.expected_version ?? null, mutation_id: i.mutation_id ?? null, base: i.base ?? null })

/** Never sent (so the server cannot have it) and idle: the only state in which a queued item may be rewritten. */
const untouched = (i: OutboxItem) => i.status === 'PENDING' && i.attempt_count === 0
export type Outbox = ReturnType<typeof createOutbox>

export function createOutbox(db: IDBDatabase) {
  const listeners = new Set<() => void>()
  const notify = () => listeners.forEach((l) => l())
  const store = (mode: IDBTransactionMode) => {
    const tx = db.transaction(OUTBOX, mode)
    return { tx, os: tx.objectStore(OUTBOX) }
  }

  async function patch(id: string, p: Partial<OutboxItem>): Promise<void> {
    const { tx, os } = store('readwrite')
    const item = await request<OutboxItem | undefined>(os.index('id').get(id))
    if (item) os.put({ ...item, ...p })
    await committed(tx)
    notify()
  }

  return {
    subscribe(cb: () => void) {
      listeners.add(cb)
      return () => void listeners.delete(cb)
    },
    async enqueue(n: NewOutboxItem): Promise<void> {
      const { tx, os } = store('readwrite')
      const item: Omit<OutboxItem, 'seq'> = {
        ...n, op: 'CREATE', expected_version: null, mutation_id: null, base: null, created_at: new Date().toISOString(), status: 'PENDING', attempt_count: 0, last_error: null,
      }
      os.add(item) // unique `id`: a duplicate UUID aborts the transaction
      await committed(tx)
      notify()
    },
    /** One user's items in creation order. Other users' items are never returned. */
    async list(userId: string): Promise<OutboxItem[]> {
      const { os } = store('readonly')
      const all = await request<OutboxItem[]>(os.index('user_id').getAll(userId))
      return all.map(norm).sort((a, b) => a.seq - b.seq)
    },
    /** What a sync run may send: this user's PENDING/FAILED items, oldest first. */
    async listSyncable(userId: string): Promise<OutboxItem[]> {
      return (await this.list(userId)).filter((i) => i.status === 'PENDING' || i.status === 'FAILED')
    },
    /** A tab that died mid-send leaves SYNCING behind; the retry is safe because replay is idempotent. */
    async resetSyncing(userId: string): Promise<void> {
      for (const i of await this.list(userId)) if (i.status === 'SYNCING') await patch(i.id, { status: 'PENDING' })
    },
    /**
     * Marks the stored item SYNCING (+1 attempt) and returns it as stored, in ONE transaction. The caller must send
     * what this returns, not the copy it listed earlier: an untouched item can be edited or removed between listing
     * and sending, and sending the stale copy would swallow the edit (or resurrect a removed item). null = gone.
     */
    async markSyncing(item: Pick<OutboxItem, 'id'>): Promise<OutboxItem | null> {
      const { tx, os } = store('readwrite')
      const cur = await request<OutboxItem | undefined>(os.index('id').get(item.id))
      const next = cur && { ...norm(cur), status: 'SYNCING' as const, attempt_count: cur.attempt_count + 1 }
      if (next) os.put(next)
      await committed(tx)
      notify()
      return next ?? null
    },
    markPending: (id: string, error: string) => patch(id, { status: 'PENDING', last_error: error }),
    markFailed: (id: string, error: string) => patch(id, { status: 'FAILED', last_error: error }),
    markBlocked: (id: string, error: string) => patch(id, { status: 'BLOCKED', last_error: error }),
    markConflict: (id: string, reason: string) => patch(id, { status: 'CONFLICT', last_error: reason }),
    /**
     * The user edited transaction `a.id`. One open item per transaction, so this folds into whatever is queued:
     * none -> a new UPDATE (expected_version = the version the user saw); CREATE or UPDATE not yet sent -> its
     * payload is replaced (the server will see one mutation, not two). Anything else throws OutboxBusyError:
     * an item that may already have reached the server cannot be rewritten (a lost response would swallow the
     * new edit), and a DELETE/BLOCKED/CONFLICT item blocks edits until it resolves or is dismissed.
     */
    async edit(a: { id: string; user_id: string; wallet_id: string; expected_version: number; payload: NewTransaction; base: TransactionRow; mutation_id?: string }): Promise<void> {
      const { tx, os } = store('readwrite')
      const cur = await request<OutboxItem | undefined>(os.index('id').get(a.id)).then((i) => i && norm(i))
      if (!cur) {
        os.add({ id: a.id, user_id: a.user_id, wallet_id: a.wallet_id, expected_version: a.expected_version, payload: a.payload, base: a.base, op: 'UPDATE', mutation_id: a.mutation_id ?? crypto.randomUUID(), created_at: new Date().toISOString(), status: 'PENDING', attempt_count: 0, last_error: null })
      } else if (cur.user_id !== a.user_id || cur.op === 'DELETE' || !untouched(cur)) {
        tx.abort()
        await committed(tx).catch(() => {})
        throw busy(cur!)
      } else os.put({ ...cur, payload: a.payload })
      await committed(tx)
      notify()
    },
    /**
     * The user deleted transaction `a.id` (own transactions only; the caller checks). none -> a new DELETE; an unsent
     * CREATE -> the item is dropped, nothing ever reaches the server; an unsent UPDATE -> becomes a DELETE at the same
     * expected_version. A DELETE already queued stays as is. Anything in doubt throws OutboxBusyError.
     */
    async remove(a: { id: string; user_id: string; wallet_id: string; expected_version: number | null; base: TransactionRow | null; mutation_id?: string }): Promise<void> {
      const { tx, os } = store('readwrite')
      const cur = await request<OutboxItem | undefined>(os.index('id').get(a.id)).then((i) => i && norm(i))
      if (!cur) {
        os.add({ id: a.id, user_id: a.user_id, wallet_id: a.wallet_id, expected_version: a.expected_version, base: a.base, op: 'DELETE', payload: null, mutation_id: a.mutation_id ?? crypto.randomUUID(), created_at: new Date().toISOString(), status: 'PENDING', attempt_count: 0, last_error: null })
      } else if (cur.user_id !== a.user_id || !(cur.op === 'DELETE' || untouched(cur))) {
        tx.abort()
        await committed(tx).catch(() => {})
        throw busy(cur!)
      } else if (cur.op === 'CREATE') os.delete(cur.seq)
      else if (cur.op === 'UPDATE') os.put({ ...cur, op: 'DELETE', payload: null })
      await committed(tx)
      notify()
    },
    /** "Keep server version" / dismiss: drops a CONFLICT or BLOCKED item without sending anything. */
    async discard(id: string): Promise<void> {
      const { tx, os } = store('readwrite')
      const item = await request<OutboxItem | undefined>(os.index('id').get(id))
      if (item && (item.status === 'CONFLICT' || item.status === 'BLOCKED')) os.delete(item.seq)
      await committed(tx)
      notify()
    },
    /** Success: the server owns the row now, so the local record is dropped (SYNCED is never stored). */
    async complete(id: string): Promise<void> {
      const { tx, os } = store('readwrite')
      const item = await request<OutboxItem | undefined>(os.index('id').get(id))
      if (item) os.delete(item.seq)
      await committed(tx)
      notify()
    },
  }
}
