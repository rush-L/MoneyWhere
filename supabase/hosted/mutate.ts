// Phase 12B: clients have no direct UPDATE/DELETE on transactions, so hosted suites mutate through the RPC the app uses.
// Same result shape as the old PostgREST calls ({ data, error }) so assertions read the same: APPLIED -> one row, anything
// else (conflict, forbidden, already gone, invisible) -> no rows; a database error comes back as `error`.
import type { SupabaseClient } from '@supabase/supabase-js'

const COLS = 'account_id, destination_account_id, category_id, type, amount_minor, date, note, version'
type Cur = { version?: number } & Record<string, unknown>

async function call(c: SupabaseClient, op: 'UPDATE' | 'DELETE', id: string, patch: Record<string, unknown>) {
  const cur = (await c.from('transactions').select(COLS).eq('id', id).maybeSingle<Cur>()).data // invisible rows: version 1, the RPC says no
  const { version = 1, ...columns } = cur ?? {}
  const payload = op === 'UPDATE' ? { ...columns, ...patch } : null
  const r = await c.rpc('apply_transaction_mutation', { p_mutation_id: crypto.randomUUID(), p_op: op, p_transaction_id: id, p_expected_version: version, p_payload: payload })
  const ok = !r.error && (r.data as { status: string }).status === 'APPLIED'
  return { data: ok ? [{ id }] : [], error: r.error }
}
export const rpcUpd = (c: SupabaseClient, id: string, patch: Record<string, unknown>) => call(c, 'UPDATE', id, patch)
export const rpcDel = (c: SupabaseClient, id: string) => call(c, 'DELETE', id, {})
