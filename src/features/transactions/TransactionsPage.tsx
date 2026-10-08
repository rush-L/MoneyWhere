import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatMinor } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import type { Account } from '../accounts/account'
import { createAccountService } from '../accounts/accountService'
import { groupCategories, type Category } from '../categories/category'
import { createCategoryService } from '../categories/categoryService'
import { readThrough, walletKey, type ReadResult } from '../offline/db/cache'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { countedPending, localBalances, mergeLocal, reconcile, type LocalTransaction } from '../offline/outbox/projection'
import { describeSync, staleNote } from '../offline/syncLabels'
import { memberLabels, participantLabel } from '../wallets/membership'
import { createMembershipService } from '../wallets/membershipService'
import type { Wallet } from '../wallets/wallet'
import { canManage, parseTransaction, hasFormerPayer, resolvePayer, todayLocal, type TransactionRow } from './transaction'
import { applyFilters, EMPTY_FILTERS, hasFilters, TYPE_LABEL, type TxFilters } from './transactionFilter'
import { createTransactionService, TransactionConflictError } from './transactionService'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { Money } from '../../ui/Money'
import { PageHeader } from '../../ui/PageHeader'
import { State } from '../../ui/State'

/** A native checkbox group: any number of values, combined with OR by the filter. */
function CheckGroup({ legend, options, selected, onChange }: { legend: string; options: { value: string; label: string }[]; selected: string[]; onChange: (v: string[]) => void }) {
  if (options.length === 0) return null
  return (
    <fieldset className="filter-group">
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className="check">
          <input type="checkbox" checked={selected.includes(o.value)} onChange={(e) => onChange(e.target.checked ? [...selected, o.value] : selected.filter((v) => v !== o.value))} />
          {o.label}
        </label>
      ))}
    </fieldset>
  )
}

type TxSnapshot = { list: TransactionRow[]; accs: Account[]; cats: Category[] }
const blank = () => ({ type: 'expense', accountId: '', destinationAccountId: '', categoryId: '', amount: '', date: todayLocal(), note: '', paidByUserId: '', keepFormer: false }) // paidByUserId '' = the signed-in user

export function TransactionsPage({ wallet, userId }: { wallet: Wallet; userId: string }) {
  const txService = useMemo(() => (supabase ? createTransactionService(supabase) : null), [])
  const { online, items, syncedTick, cache, saveTransaction, editTransaction, deleteTransaction, discardItem } = useOffline()
  useWatchWallet(wallet.id)
  const seq = useRef(0) // newest load wins
  const [stale, setStale] = useState(false) // showing the last saved snapshot because the server is unreachable
  const [checking, setChecking] = useState(false) // ...and a background refresh is under way
  const tick0 = useRef(syncedTick) // the first load may show the snapshot while revalidating; reloads after a sync may not
  const [notice, setNotice] = useState<string | null>(null)
  const [txs, setTxs] = useState<TransactionRow[] | null>(null)
  const [accounts, setAccounts] = useState<Account[]>([])
  const [categories, setCategories] = useState<Category[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(blank)
  const [editing, setEditing] = useState<TransactionRow | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [filters, setFilters] = useState<TxFilters>(EMPTY_FILTERS) // local only: not persisted, reset on wallet change and reload
  const [filterWallet, setFilterWallet] = useState(wallet.id)
  if (filterWallet !== wallet.id) {
    setFilterWallet(wallet.id)
    setFilters(EMPTY_FILTERS)
  }
  const [formOpen, setFormOpen] = useState(false) // dialog visibility only; the form state above stays on this page
  const [formError, setFormError] = useState<string | null>(null)
  const isOwner = wallet.role === 'owner' // UX only; RLS enforces it

  const itemsRef = useRef(items)
  const expectedRef = useRef<Map<string, number> | null>(null) // balances we displayed with pending items included
  useEffect(() => {
    itemsRef.current = items
  }, [items])

  const load = useCallback(
    (initial = false) => {
      const n = ++seq.current
      const apply = ({ data, stale, revalidating }: ReadResult<TxSnapshot>) => {
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
        setChecking(!!revalidating)
        setLoadError(null)
      }
      return txService &&
      readThrough<TxSnapshot>(cache, walletKey(userId, wallet.id), async () => {
        const [list, accs, cats] = await Promise.all([
          txService.list(wallet.id),
          createAccountService(supabase!).list(wallet.id),
          createCategoryService(supabase!).list(wallet.id),
        ])
        return { list, accs, cats }
      }, initial ? apply : undefined).then(
        apply,
        (e: Error) => n === seq.current && setLoadError(e.message),
      )
    },
    [txService, wallet.id, userId, cache],
  )

  useEffect(() => {
    void load(syncedTick === tick0.current)
  }, [load, syncedTick]) // syncedTick: a queued transaction just synced, so refresh server balances

  // Local view = server baseline + unsynced items (domain accountBalance replays only the pending rows).
  const shown = useMemo(() => (txs ? mergeLocal(txs, items, wallet.id) : null), [txs, items, wallet.id])
  const localAccounts = useMemo(() => (txs ? localBalances(accounts, txs, items, wallet.id) : accounts), [accounts, txs, items, wallet.id])
  useEffect(() => {
    expectedRef.current = txs && countedPending(txs, items, wallet.id).length ? new Map(localAccounts.map((a) => [a.id, a.currentBalanceMinor])) : null
  }, [localAccounts, txs, items, wallet.id])

  // Current members of this wallet (null until loaded, or offline): the only source of names. Someone not in it is a former member.
  const memberService = useMemo(() => (supabase ? createMembershipService(supabase) : null), [])
  const [labels, setLabels] = useState<Map<string, string> | null>(null)
  useEffect(() => {
    let live = true
    memberService?.listMembers(wallet.id).then(
      (m) => live && setLabels(memberLabels(m, userId)),
      () => {}, // offline or failed: keep what we have; unknown people show as "Another member"
    )
    return () => { live = false }
  }, [memberService, wallet.id, userId, syncedTick])

  const accountName = (id: string) => accounts.find((a) => a.id === id)?.name ?? 'Unknown account'
  const categoryName = (id: string | null) => (id ? (categories.find((c) => c.id === id)?.name ?? 'Unknown category') : '—')
  // Search and filters run over `shown` (server rows + pending offline rows), before the day grouping below. Names are the ones displayed:
  // offline, a payer other than "You" is "Another member", and that is what a search matches.
  const lookup = {
    accountName,
    categoryName: (id: string) => categoryName(id),
    parentCategoryName: (id: string) => {
      const parent = categories.find((c) => c.id === id)?.parentId
      return parent ? (categories.find((c) => c.id === parent)?.name ?? null) : null
    },
    parentCategoryId: (id: string) => categories.find((c) => c.id === id)?.parentId ?? null,
    payerLabel: (id: string | null) => participantLabel(id, userId, labels),
  }
  const filtered = shown ? applyFilters(shown, filters, lookup) : null // cheap enough to run per render
  const filtersOn = hasFilters(filters)
  const patch = (p: Partial<TxFilters>) => setFilters({ ...filters, ...p })
  const typeOptions = Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))
  const accountOptionsF = accounts.map((a) => ({ value: a.id, label: a.name }))
  const categoryOptionsF = groupCategories(categories).flatMap((g) => [{ value: g.category.id, label: g.category.name }, ...g.children.map((c) => ({ value: c.id, label: `${g.category.name} › ${c.name}` }))])
  const payerOptions = (() => {
    const seen = [...new Set([userId, ...(labels?.keys() ?? []), ...(shown ?? []).map((t) => t.paid_by_user_id).filter((x): x is string => !!x)])]
    let former = 0
    const formerCount = seen.filter((id) => participantLabel(id, userId, labels) === 'Former member').length
    return seen.map((id) => {
      const label = participantLabel(id, userId, labels)
      return { value: id, label: label === 'Former member' && formerCount > 1 ? `Former member ${++former}` : label }
    })
  })()
  const set = (k: keyof ReturnType<typeof blank>) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  // Who Paid / Received by: current members only (the server enforces it). An edited row whose payer has since left keeps
  // that value as "Former member" so saving does not silently reassign it; offline (no member list) only "You" is offered.
  // An anonymized payer (null) is kept as "Former member (unchanged)" until a member is explicitly chosen; it is never reassigned to the editor.
  // (keepFormer lives in the form state, set by startEdit; the helper is memoized because the React compiler lint rejects a bare call here.)
  const keepFormer = form.keepFormer
  const payerId = useMemo(() => resolvePayer(keepFormer, form.paidByUserId, userId), [keepFormer, form.paidByUserId, userId])
  const payerIds = [...new Set([userId, ...(labels?.keys() ?? []), payerId])].filter(Boolean)

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseTransaction({ ...form, paidByUserId: payerId })
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
      setFormOpen(false)
      await load() // offline this falls back to the saved snapshot; the queued item is merged in by `shown`
    } catch (e) {
      if (e instanceof TransactionConflictError) {
        // The row changed under us. Close and reset the edit (an edit that lost `editing` but kept its dialog and values
        // would submit as a new transaction); the persistent notice explains, and Edit reopens on the latest version.
        cancelEdit()
        setNotice(e.message)
        void load()
      } else setFormError(e instanceof Error ? e.message : 'Could not save the transaction.')
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
    setFormOpen(true)
    setForm({ type: t.type, accountId: t.account_id, destinationAccountId: t.destination_account_id ?? '', categoryId: t.category_id ?? '', amount: formatMinor(t.amount_minor), date: t.date, note: t.note ?? '', paidByUserId: t.paid_by_user_id ?? '', keepFormer: hasFormerPayer(t) })
  }
  function cancelEdit() {
    setEditing(null)
    setFormError(null)
    setForm(blank())
    setFormOpen(false)
  }
  // Closing the dialog cancels an edit (as Cancel did); a half-typed new transaction is kept, as the inline form kept it.
  function closeForm() {
    if (editing) cancelEdit()
    else setFormOpen(false)
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
  const paidBy = (t: TransactionRow) => participantLabel(t.paid_by_user_id, userId, labels)

  const typeLabel = (t: TransactionRow) => (t.type === 'transfer' ? 'Transfer' : t.type === 'income' ? 'Income' : 'Expense')
  const typeSign = (t: TransactionRow) => (t.type === 'transfer' ? '↔' : t.type === 'income' ? '+' : '−')
  const typeTone = (t: TransactionRow) => (t.type === 'transfer' ? 'info' : t.type === 'income' ? 'good' : 'neutral')
  // Presentation only: consecutive rows with the same date share a heading; order and content of `shown` are untouched.
  const days: { date: string; rows: LocalTransaction[] }[] = []
  for (const t of filtered ?? []) {
    const last = days[days.length - 1]
    if (last && last.date === t.date) last.rows.push(t)
    else days.push({ date: t.date, rows: [t] })
  }

  return (
    <>
      <PageHeader
        title="Transactions"
        level={2}
        actions={accounts.length > 0 ? <Button onClick={() => { setFormError(null); setFormOpen(true) }}>+ Add</Button> : undefined}
      />
      {loadError && <State kind="error">{loadError}</State>}
      {stale && <p role="status" className="note">{staleNote(checking)}</p>}
      {notice && <p role="status" className="note info">{notice}</p>}
      {!shown && !loadError && <State kind="loading">Loading transactions…</State>}
      {shown?.length === 0 && <State kind="empty">No transactions yet.</State>}
      {shown && shown.length > 0 && (
        <div className="filters">
          <Field label="Search">
            <input type="search" value={filters.search} placeholder="Note, account, category, who paid, type" onChange={(e) => patch({ search: e.target.value })} />
          </Field>
          <details className="filter-panel">
            <summary>Filters{filtersOn ? ' (on)' : ''}</summary>
            <div className="filter-dates">
              <Field label="From"><input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => patch({ from: e.target.value })} /></Field>
              <Field label="To"><input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => patch({ to: e.target.value })} /></Field>
            </div>
            <CheckGroup legend="Type" options={typeOptions} selected={filters.types} onChange={(types) => patch({ types })} />
            <CheckGroup legend="Account" options={accountOptionsF} selected={filters.accountIds} onChange={(accountIds) => patch({ accountIds })} />
            <CheckGroup legend="Category" options={categoryOptionsF} selected={filters.categoryIds} onChange={(categoryIds) => patch({ categoryIds })} />
            <CheckGroup legend="Who paid / Received by" options={payerOptions} selected={filters.payerIds} onChange={(payerIds) => patch({ payerIds })} />
          </details>
          {filtersOn && <div className="actions"><Button variant="ghost" onClick={() => setFilters(EMPTY_FILTERS)}>Clear filters</Button></div>}
        </div>
      )}
      {shown && shown.length > 0 && filtered?.length === 0 && <State kind="empty">No matching transactions</State>}
      {days.map((day, i) => (
        <section key={`${day.date}-${i}`} className="tx-day">
          <h3 className="tx-date">{day.date}</h3>
          <ul className="tx-list">
            {day.rows.map((t) => (
              <li key={t.id} className={`card tx${t.sync ? ' pending' : ''}`}>
                <div className="tx-top">
                  <Badge tone={typeTone(t)}>{typeLabel(t)}</Badge>
                  <strong className="tx-amount"><Money minor={t.amount_minor} prefix={typeSign(t)} /></strong>
                </div>
                {t.type === 'transfer' ? (
                  <small>↔ {accountName(t.account_id)} → {accountName(t.destination_account_id ?? '')}</small>
                ) : (
                  <small>{accountName(t.account_id)} · {categoryName(t.category_id)} · {t.type === 'income' ? 'Received by' : 'Paid by'}: {paidBy(t)}</small>
                )}
                {t.note && <small>{t.note}</small>}
                {t.sync && (() => {
                  const d = describeSync(t.sync, (items.find((i) => i.id === t.id)?.attempt_count ?? 0) > 0)
                  return (
                    <>
                      <small role="status" className={d.tone === 'error' ? 'error' : d.tone === 'warn' ? 'warn' : undefined}>{d.text}</small>
                      {(t.sync === 'CONFLICT' || t.sync === 'BLOCKED') && (
                        <div className="actions">
                          <Button variant="secondary" onClick={() => void discardItem(t.id).then(() => load())}>{t.sync === 'CONFLICT' ? 'Keep server version' : 'Dismiss'}</Button>
                        </div>
                      )}
                    </>
                  )
                })()}
                {(!t.sync || syncEditable(t)) && offlineEditable(t) && (
                  <div className="actions">
                    <Button variant="secondary" onClick={() => startEdit(t)}>Edit</Button>
                    {confirmDelete === t.id ? (
                      <>
                        <Button variant="danger" onClick={() => void remove(t)}>Confirm delete</Button>
                        <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                      </>
                    ) : (
                      <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(t.id)}>Delete</Button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {accounts.length === 0 ? (
        txs && <State kind="empty">Add an account first (owner), then record transactions here.</State>
      ) : (
        <Dialog open={formOpen} onClose={closeForm} dismissible={!busy} title={editing ? 'Edit transaction' : transfer ? 'New transfer' : 'New transaction'}>
          <form onSubmit={(e) => void save(e)} noValidate>
            <Field label="Type">
              <select value={form.type} onChange={set('type')} disabled={busy}>
                <option value="expense">Expense</option>
                <option value="income">Income</option>
                <option value="transfer">Transfer</option>
              </select>
            </Field>
            <Field label="Amount (₱)">
              <input inputMode="decimal" value={form.amount} placeholder="0.00" onChange={set('amount')} disabled={busy} />
            </Field>
            <Field label={transfer ? 'From Account' : 'Account'}>
              <select value={form.accountId} onChange={set('accountId')} disabled={busy}>
                <option value="">Choose…</option>
                {accountOptions(form.destinationAccountId)}
              </select>
            </Field>
            {transfer && (
              <Field label="To Account">
                <select value={form.destinationAccountId} onChange={set('destinationAccountId')} disabled={busy}>
                  <option value="">Choose…</option>
                  {accountOptions(form.accountId)}
                </select>
              </Field>
            )}
            {form.type === 'expense' && (
              <Field label="Category">
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
              </Field>
            )}
            <Field label="Transaction Date">
              <input type="date" value={form.date} onChange={set('date')} disabled={busy} />
            </Field>
            <Field label="Note (optional)"><input value={form.note} maxLength={500} onChange={set('note')} disabled={busy} /></Field>
            {!transfer && (
              <Field label={form.type === 'income' ? 'Received by' : 'Who Paid'}>
                <select value={payerId} onChange={set('paidByUserId')} disabled={busy}>
                  {form.keepFormer ? <option value="">Former member (unchanged)</option> : null}
                  {payerIds.map((id) => <option key={id} value={id}>{participantLabel(id, userId, labels)}</option>)}
                </select>
              </Field>
            )}
            {formError && <p role="alert" className="error">{formError}</p>}
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : editing ? 'Save Changes' : transfer ? 'Add Transfer' : 'Add Transaction'}</Button>
          </form>
        </Dialog>
      )}
    </>
  )
}
