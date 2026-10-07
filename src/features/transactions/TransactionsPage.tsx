import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatMinor } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import type { Account } from '../accounts/account'
import { createAccountService } from '../accounts/accountService'
import { groupCategories, type Category } from '../categories/category'
import { createCategoryService } from '../categories/categoryService'
import { readThrough, walletKey } from '../offline/db/cache'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { countedPending, localBalances, mergeLocal, reconcile, type LocalTransaction } from '../offline/outbox/projection'
import { describeSync } from '../offline/syncLabels'
import type { Wallet } from '../wallets/wallet'
import { canManage, parseTransaction, todayLocal, type TransactionRow } from './transaction'
import { createTransactionService, TransactionConflictError } from './transactionService'

const blank = () => ({ type: 'expense', accountId: '', destinationAccountId: '', categoryId: '', amount: '', date: todayLocal(), note: '' })

export function TransactionsPage({ wallet, userId, onBack }: { wallet: Wallet; userId: string; onBack: () => void }) {
  const txService = useMemo(() => (supabase ? createTransactionService(supabase) : null), [])
  const { online, items, syncedTick, cache, saveTransaction, editTransaction, deleteTransaction, discardItem } = useOffline()
  useWatchWallet(wallet.id)
  const seq = useRef(0) // newest load wins
  const [stale, setStale] = useState(false) // showing the last saved snapshot because the server is unreachable
  const [notice, setNotice] = useState<string | null>(null)
  const [txs, setTxs] = useState<TransactionRow[] | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(blank)
  const [editing, setEditing] = useState<TransactionRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const isOwner = wallet.role === 'owner' // UX only; RLS enforces it

  const itemsRef = useRef(items)
  const expectedRef = useRef<Map<string, number> | null>(null) // balances we displayed with pending items included
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const load = useCallback(
    () => {
      const n = ++seq.current
      return txService &&
      readThrough(cache, walletKey(userId, wallet.id), async () => {
        const [list, accs, cats] = await Promise.all([
          txService.list(wallet.id),
          createAccountService(supabase!).list(wallet.id),
          createCategoryService(supabase!).list(wallet.id),
        ])
        return { list, accs, cats }
      }).then(
        ({ data, stale }) => {
          if (n !== seq.current) return
          // Server aggregate is authoritative once synced; a mismatch with what we showed is logged, not "fixed".
          if (!stale && expectedRef.current && countedPending(data.list, itemsRef.current, wallet.id).length === 0) {
            const diff = reconcile(expectedRef.current, data.accs)
            if (diff.length) console.warn('[offline] balance reconciliation mismatch (server value kept)', diff)
            expectedRef.current = null
          }
          setTxs(data.list)
          setAccounts(data.accs)
          setCategories(data.cats)
          setStale(stale)
          setLoadError(null)
        },
        (e: Error) => n === seq.current && setLoadError(e.message),
      )
    },
    [txService, wallet.id, userId, cache],
  )

  useEffect(() => {
    void load()
  }, [load, syncedTick]) // syncedTick: a queued transaction just synced, so refresh server balances

  // Local view = server baseline + unsynced items (domain accountBalance replays only the pending rows).
  const shown = useMemo(() => (txs ? mergeLocal(txs, items, wallet.id) : null), [txs, items, wallet.id])
  const localAccounts = useMemo(() => (txs ? localBalances(accounts, txs, items, wallet.id) : accounts), [accounts, txs, items, wallet.id])
  useEffect(() => {
    expectedRef.current = txs && countedPending(txs, items, wallet.id).length ? new Map(localAccounts.map((a) => [a.id, a.currentBalanceMinor])) : null
  }, [localAccounts, txs, items, wallet.id])

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account'
  const categoryName = (id: string | null) => (id ? (categories.find((c) => c.id === id)?.name ?? 'Unknown category') : '—')
  const set = (k: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseTransaction(form)
    if (!parsed.ok) return setFormError(parsed.error)
    setBusy(true)
    setFormError(null)
    setNotice(null)
    try {
      if (editing) {
        if ((await editTransaction(wallet.id, editing, parsed.value)) === 'queued') setNotice('Saved to device · Pending sync')
      } else if ((await saveTransaction(wallet.id, parsed.value)) === 'queued') setNotice('Saved to device · Pending sync')
      setEditing(null)
      setForm(blank())
      await load() // offline this falls back to the saved snapshot; the queued item is merged in by `shown`
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the transaction.')
      if (e instanceof TransactionConflictError) {
        setEditing(null) // the row changed under us: the form would only re-submit a stale version
        void load()
      }
    } finally {
      setBusy(false)
    }
  }

  async function remove(t: TransactionRow) {
    setConfirmDelete(null)
    try {
      if ((await deleteTransaction(wallet.id, t)) === 'queued') setNotice('Deleted on this device · Pending sync')
      if (editing?.id === t.id) cancelEdit()
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not delete the transaction.')
      if (e instanceof TransactionConflictError) void load()
    }
  }

  function startEdit(t: TransactionRow) {
    setEditing(t)
    setFormError(null)
    setForm({ type: t.type, accountId: t.account_id, destinationAccountId: t.destination_account_id ?? '', categoryId: t.category_id ?? '', amount: formatMinor(t.amount_minor), date: t.date, note: t.note ?? '' })
  }
  function cancelEdit() {
    setEditing(null)
    setFormError(null)
    setForm(blank())
  }

  const groups = groupCategories(categories)
  const transfer = form.type === 'transfer'
  // The other side's account is left out so the same account cannot be picked twice.
  const accountOptions = (exclude: string) =>
    localAccounts.filter((a) => !transfer || a.id !== exclude).map((a) => (
      <option key={a.id} value={a.id}>{a.name} (₱{formatMinor(a.currentBalanceMinor)})</option>
    ))
  // Online: owner any, member own (the server enforces it). Offline: own transactions only, and the row needs its version
  // (a pending create has none yet). Owner edits of other members' transactions stay online-only.
  const offlineEditable = (t: LocalTransaction) => canManage(isOwner, t, userId) && (online || (t.created_by === userId && (t.version !== undefined || !!t.sync)))
  const syncEditable = (t: LocalTransaction) => !!t.sync && describeSync(t.sync, (items.find((i) => i.id === t.id)?.attempt_count ?? 0) > 0).editable
  const paidBy = (t: TransactionRow) => (t.paid_by_user_id === userId ? 'Me' : 'Another member')

  return (
    <section className="card">
      <button type="button" className="link" onClick={onBack}>← Wallets</button>
      <h2>{wallet.name} · Transactions</h2>
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {stale && <p role="status"><small>Showing data saved on this device. Reconnect to refresh.</small></p>}
      {notice && <p role="status">{notice}</p>}
      {!shown && !loadError && <p role="status">Loading transactions…</p>}
      {shown?.length === 0 && <p>No transactions yet.</p>}
      {shown && shown.length > 0 && (
        <ul className="list">
          {shown.map((t) => (
            <li key={t.id} className={t.sync ? 'pending' : undefined}>
              <strong>{t.type === 'transfer' ? '↔' : t.type === 'income' ? '+' : '−'}₱{formatMinor(t.amount_minor)}</strong>{' '}
              <small>{t.type === 'transfer' ? 'Transfer' : t.type === 'income' ? 'Income' : 'Expense'} · {t.date}</small>
              <br />
              {t.type === 'transfer' ? (
                <small>↔ {accountName(t.account_id)} → {accountName(t.destination_account_id ?? '')}</small>
              ) : (
                <small>{accountName(t.account_id)} · {categoryName(t.category_id)} · Paid by: {paidBy(t)}</small>
              )}
              {t.note && <><br /><small>{t.note}</small></>}
              {t.sync && (() => {
                const d = describeSync(t.sync, (items.find((i) => i.id === t.id)?.attempt_count ?? 0) > 0)
                return (
                  <>
                    <br />
                    <small role="status" className={d.tone === 'error' ? 'error' : d.tone === 'warn' ? 'warn' : undefined}>{d.text}</small>
                    {(t.sync === 'CONFLICT' || t.sync === 'BLOCKED') && (
                      <>{' '}<button type="button" className="link" onClick={() => void discardItem(t.id).then(() => load())}>{t.sync === 'CONFLICT' ? 'Keep server version' : 'Dismiss'}</button></>
                    )}
                  </>
                )
              })()}
              {(!t.sync || syncEditable(t)) && offlineEditable(t) && (
                <>
                  <br />
                  <button type="button" className="link" onClick={() => startEdit(t)}>Edit</button>
                  {confirmDelete === t.id ? (
                    <>
                      {' '}<button type="button" className="link" onClick={() => void remove(t)}>Confirm delete</button>
                      {' '}<button type="button" className="link" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </>
                  ) : (
                    <>{' '}<button type="button" className="link" onClick={() => setConfirmDelete(t.id)}>Delete</button></>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {accounts.length === 0 ? (
        txs && <small>Add an account first (owner), then record transactions here.</small>
      ) : (
        <form onSubmit={(e) => void save(e)} noValidate>
          <strong>{editing ? 'Edit transaction' : transfer ? 'New transfer' : 'New transaction'}</strong>
          <label>
            Type
            <select value={form.type} onChange={set('type')} disabled={busy}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
              <option value="transfer">Transfer</option>
            </select>
          </label>
          <label>
            Amount (₱)
            <input inputMode="decimal" value={form.amount} placeholder="0.00" onChange={set('amount')} disabled={busy} />
          </label>
          <label>
            {transfer ? 'From Account' : 'Account'}
            <select value={form.accountId} onChange={set('accountId')} disabled={busy}>
              <option value="">Choose…</option>
              {accountOptions(form.destinationAccountId)}
            </select>
          </label>
          {transfer && (
            <label>
              To Account
              <select value={form.destinationAccountId} onChange={set('destinationAccountId')} disabled={busy}>
                <option value="">Choose…</option>
                {accountOptions(form.accountId)}
              </select>
            </label>
          )}
          {form.type === 'expense' && (
            <label>
              Category
              <select value={form.categoryId} onChange={set('categoryId')} disabled={busy}>
                <option value="">Choose…</option>
                {groups.map((g) =>
                  g.children.length === 0 ? (
                    <option key={g.category.id} value={g.category.id}>{g.category.name}</option>
                  ) : (
                    <optgroup key={g.category.id} label={g.category.name}>
                      <option value={g.category.id}>{g.category.name} (general)</option>
                      {g.children.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </optgroup>
                  ),
                )}
              </select>
            </label>
          )}
          <label>
            Transaction Date
            <input type="date" value={form.date} onChange={set('date')} disabled={busy} />
          </label>
          <label>Note (optional)<input value={form.note} maxLength={500} onChange={set('note')} disabled={busy} /></label>
          {!transfer && <small>Paid by: Me</small>}
          {formError && <p role="alert" className="error">{formError}</p>}
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save Changes' : transfer ? 'Add Transfer' : 'Add Transaction'}</button>
          {editing && <button type="button" className="link" onClick={cancelEdit} disabled={busy}>Cancel</button>}
        </form>
      )}
    </section>
  )
}
