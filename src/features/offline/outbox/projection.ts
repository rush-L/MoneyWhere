import { accountBalance, sub, type Minor, type Transaction } from '../../../domain/finance'
import type { Account } from '../../accounts/account'
import type { TransactionRow } from '../../transactions/transaction'
import type { OutboxItem, OutboxStatus } from './outbox'

/** A transaction row as shown locally; `sync` is set only while the server has not confirmed it. */
export type LocalTransaction = TransactionRow & { sync?: Exclude<OutboxStatus, 'SYNCED'> }

/** A pending CREATE as a row. created_by is display-only (the item's owner); paid_by is the chosen payer, else the owner. The database sets the real ones. */
export const itemToRow = (i: OutboxItem): LocalTransaction => ({
  id: i.id,
  ...i.payload!,
  created_by: i.user_id,
  paid_by_user_id: i.payload!.type === 'transfer' ? null : (i.payload!.paid_by_user_id ?? i.user_id),
  sync: i.status === 'SYNCED' ? undefined : i.status,
})

/** What the server has for a pending item's transaction. A bare id (no `type`) only proves existence; a full row also carries `version`. */
type Ref = { id: string } | TransactionRow
const isRow = (r: Ref): r is TransactionRow => 'type' in r

/**
 * The single place that decides what each open outbox item does to the server baseline. Everything else
 * (transactions list, balances, dashboard, budgets) derives from this, so there is one rule, not several.
 *
 *  CREATE  not on the server yet  -> `added` (BLOCKED never applies, so it is not counted). On the server -> the server row wins.
 *  UPDATE  server row + payload   -> `superseded` (the server row is replaced by the overlay in `overlaid`).
 *  DELETE  server row             -> `superseded` and nothing overlaid (excluded).
 *  A BLOCKED/CONFLICT item, or one whose expected_version no longer matches the server row (someone changed it:
 *  it can only end in CONFLICT), changes nothing: the server row stands. An UPDATE/DELETE whose row is gone from a
 *  loaded server list is dropped from the projection too (it will conflict / is already deleted).
 *  `doomed` lists those rows so the page can flag them.
 */
export function pendingEffect(server: readonly Ref[], items: readonly OutboxItem[], walletId?: string) {
  const byId = new Map<string, Ref>()
  for (const r of server) if (isRow(r) || !byId.has(r.id)) byId.set(r.id, r) // a full row beats a bare id
  const out = { added: [] as LocalTransaction[], listed: [] as LocalTransaction[], superseded: [] as TransactionRow[], overlaid: new Map<string, LocalTransaction>(), deleted: new Set<string>(), doomed: new Set<string>() }
  for (const i of items) {
    if (walletId !== undefined && i.wallet_id !== walletId) continue
    const op = i.op ?? 'CREATE'
    const ref = byId.get(i.id)
    if (op === 'CREATE') {
      if (!ref) {
        out.listed.push(itemToRow(i)) // always shown, so a BLOCKED create stays visible...
        if (i.status !== 'BLOCKED' && i.status !== 'CONFLICT') out.added.push(itemToRow(i)) // ...but only live ones are counted
      }
      continue
    }
    // A full server row (Transactions page) is the truth and can prove the item stale. Otherwise (Dashboard, Accounts,
    // offline) the baseline is the row the user saw when they queued it.
    const row = ref && isRow(ref) ? ref : i.base
    if (!row) continue
    const dead = i.status === 'BLOCKED' || i.status === 'CONFLICT' || (row.version !== undefined && i.expected_version !== null && row.version !== i.expected_version)
    if (dead) {
      out.doomed.add(i.id)
      continue
    }
    out.superseded.push(row)
    if (op === 'DELETE') out.deleted.add(i.id)
    else {
      const p = i.payload!
      // No payer in the payload (queued before D7, or "keep") keeps the row's payer, even null (an anonymized payer stays
      // Former member, never the creator); a transfer has none. A transfer turned into income/expense with no payer takes the user.
      const paid = p.type === 'transfer' ? null : (p.paid_by_user_id ?? (row.type === 'transfer' ? i.user_id : row.paid_by_user_id))
      out.overlaid.set(i.id, { ...row, ...p, paid_by_user_id: paid, sync: i.status === 'SYNCED' ? undefined : i.status })
    }
  }
  return out
}

/** Pending rows (newest first) on top of the server list; edited rows are replaced in place, deleted rows dropped. */
export function mergeLocal(server: readonly TransactionRow[], items: readonly OutboxItem[], walletId: string): LocalTransaction[] {
  const e = pendingEffect(server, items, walletId)
  const pending = e.listed.sort((a, b) => (a.date === b.date ? 0 : a.date < b.date ? 1 : -1))
  const rows = server
    .filter((t) => !e.deleted.has(t.id))
    .map((t): LocalTransaction => e.overlaid.get(t.id) ?? (e.doomed.has(t.id) ? { ...t, sync: 'CONFLICT' } : t))
  return [...pending, ...rows]
}

/** Rows whose pending state changes balances: new ones, plus server rows being replaced or removed. Empty = nothing pending counts. */
export const countedPending = (server: readonly Ref[], items: readonly OutboxItem[], walletId: string): Transaction[] => {
  const e = pendingEffect(server, items, walletId)
  return [...e.added, ...e.superseded]
}

/**
 * Server baseline + pending, via the domain accountBalance(): the server's current balance is the "opening"
 * and only the pending rows are replayed on top. No second balance formula.
 */
export function localBalances(accounts: readonly Account[], server: readonly Ref[], items: readonly OutboxItem[], walletId: string): Account[] {
  const e = pendingEffect(server, items, walletId)
  const after = [...e.added, ...e.overlaid.values()]
  // The server balance already counts the superseded rows: take their effect out (accountBalance from 0), then replay the new state.
  return accounts.map((a) => ({ ...a, currentBalanceMinor: accountBalance(a.id, sub(a.currentBalanceMinor, accountBalance(a.id, 0, e.superseded)), after) }))
}

/** After a sync: server aggregate vs what we displayed. Differences are logged; the server value is kept. */
export function reconcile(expected: ReadonlyMap<string, Minor>, accounts: readonly Account[]): { accountId: string; expected: Minor; server: Minor }[] {
  return accounts.flatMap((a) => {
    const e = expected.get(a.id)
    return e !== undefined && e !== a.currentBalanceMinor ? [{ accountId: a.id, expected: e, server: a.currentBalanceMinor }] : []
  })
}

/**
 * Spending rows = server rows + counted pending ones (the domain `spendingByBudgetCategory` then keeps only this
 * month's expenses; income/transfers never count). `confirmed`: ids the server has that `spend` may not list.
 */
export function localSpend<S extends { id: string }>(spend: readonly S[], confirmed: readonly Ref[], items: readonly OutboxItem[], walletId: string): (S | Transaction)[] {
  const e = pendingEffect([...spend.map((s) => ({ id: s.id })), ...confirmed], items, walletId) // spend rows are partial: only full rows in `confirmed` can be overlaid
  const gone = new Set(e.superseded.map((r) => r.id))
  return [...spend.filter((s) => !gone.has(s.id)), ...e.added, ...e.overlaid.values()]
}
