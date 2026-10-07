import type { SupabaseClient } from '@supabase/supabase-js'
import { IntegrityError, type SendFailure } from '../offline/sync/errors'
import { TRANSACTION_COLUMNS, type NewTransaction, type TransactionRow } from './transaction'

/** Message is always safe to show to the user. */
export class TransactionError extends Error {}
/** The row changed (or vanished) since the user loaded it; nothing was written. */
export class TransactionConflictError extends TransactionError {}

export type MutationOutcome =
  | { status: 'APPLIED' | 'ALREADY_APPLIED'; version: number }
  | { status: 'ALREADY_GONE' | 'FORBIDDEN' }
  | { status: 'CONFLICT'; reason: 'version_mismatch' | 'not_found'; version?: number }

function fail(message: string, err: unknown): never {
  console.error('[transactions]', err)
  throw new TransactionError(message, { cause: err }) // cause: lets the offline layer tell network-down from a real refusal
}

const PAGE = 1000 // PostgREST's default row cap; a silent cut-off would corrupt balances

export function createTransactionService(client: SupabaseClient) {
  return {
    /** Every transaction of the wallet (RLS limits rows to members), newest first. Paged so balances stay exact. */
    async list(walletId: string): Promise<TransactionRow[]> {
      const all: TransactionRow[] = []
      for (let from = 0; ; from += PAGE) {
        const { data, error } = await client
          .from('transactions')
          .select(TRANSACTION_COLUMNS)
          .eq('wallet_id', walletId)
          .order('date', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, from + PAGE - 1)
          .returns<TransactionRow[]>()
        if (error) fail('Could not load transactions. Please try again.', error)
        all.push(...data)
        if (data.length < PAGE) return all
      }
    },
    /**
     * Idempotent insert under a client UUID (the same one used locally and in the outbox). created_by,
     * paid_by_user_id and wallet_id are not sent: the database sets them. Throws the raw failure for the sync
     * engine to classify. A duplicate id (23505) means an earlier attempt may have committed: it counts as
     * success only if the row is visible to us and was created by `userId`; otherwise IntegrityError.
     */
    async send(id: string, userId: string, t: NewTransaction): Promise<void> {
      const { error, status } = await client.from('transactions').insert({ id, ...t })
      if (!error) return
      if (error.code !== '23505') throw { code: error.code, message: error.message, status } satisfies SendFailure
      const { data, error: e2, status: s2 } = await client.from('transactions').select('id, created_by').eq('id', id).maybeSingle()
      if (e2) throw { code: e2.code, message: e2.message, status: s2 } satisfies SendFailure
      if (data?.created_by !== userId) throw new IntegrityError(`Transaction id ${id} already exists and is not yours; not overwritten.`)
    },
    /**
     * Which of these ids the server already has (ids only, never the history): lets an outbox item the server has
     * already counted be counted once. Chunked to keep the URL short; no ids means no request.
     */
    async existingIds(ids: readonly string[]): Promise<string[]> {
      const found: string[] = []
      for (let i = 0; i < ids.length; i += 100) {
        const { data, error } = await client.from('transactions').select('id').in('id', ids.slice(i, i + 100)).returns<{ id: string }[]>()
        if (error) fail('Could not load transactions. Please try again.', error)
        found.push(...data.map((r) => r.id))
      }
      return found
    },
    /**
     * The one UPDATE/DELETE path (online and offline replay): the version check, the caller's authorization and the
     * write happen atomically in apply_transaction_mutation. A conflict is a normal result, not an error; real
     * failures are thrown raw for the sync engine to classify. `ownOnly` restricts to rows the caller created.
     */
    async mutate(m: { mutationId: string; op: 'UPDATE' | 'DELETE'; id: string; expectedVersion: number | null; payload: NewTransaction | null; ownOnly: boolean }): Promise<MutationOutcome> {
      const { data, error, status } = await client.rpc('apply_transaction_mutation', {
        p_mutation_id: m.mutationId, p_op: m.op, p_transaction_id: m.id, p_expected_version: m.expectedVersion, p_payload: m.payload, p_own_only: m.ownOnly,
      })
      if (error) throw { code: error.code, message: error.message, status } satisfies SendFailure
      return data as MutationOutcome
    },
    /** `expectedVersion` is the version of the row the user saw; if someone changed it since, nothing is overwritten. */
    async update(id: string, expectedVersion: number | undefined, t: NewTransaction, mutationId: string = crypto.randomUUID()): Promise<void> {
      const r = await this.mutate({ mutationId, op: 'UPDATE', id, expectedVersion: expectedVersion ?? null, payload: t, ownOnly: false })
        .catch((e) => fail('Could not save the transaction. Please try again.', e))
      if (r.status === 'APPLIED' || r.status === 'ALREADY_APPLIED') return
      if (r.status === 'CONFLICT') throw new TransactionConflictError('Someone changed this transaction. Your edit was not saved; the latest version is shown.')
      fail('Could not save the transaction. You can only edit transactions you created.', r)
    },
    async remove(id: string, expectedVersion: number | undefined, mutationId: string = crypto.randomUUID()): Promise<void> {
      const r = await this.mutate({ mutationId, op: 'DELETE', id, expectedVersion: expectedVersion ?? null, payload: null, ownOnly: false })
        .catch((e) => fail('Could not delete the transaction. Please try again.', e))
      if (r.status === 'APPLIED' || r.status === 'ALREADY_APPLIED' || r.status === 'ALREADY_GONE') return
      if (r.status === 'CONFLICT') throw new TransactionConflictError('Someone changed this transaction, so it was not deleted. The latest version is shown.')
      fail('Could not delete the transaction. You can only delete transactions you created.', r)
    },
  }
}
