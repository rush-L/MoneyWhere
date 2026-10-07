import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { calculateBudgetStatus, formatMinor, spendingByBudgetCategory } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import type { Category } from '../categories/category'
import { readThrough, type ReadResult } from '../offline/db/cache'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { budgetsKey } from '../offline/localFinance'
import { localSpend } from '../offline/outbox/projection'
import { staleNote } from '../offline/syncLabels'
import { createCategoryService } from '../categories/categoryService'
import type { Wallet } from '../wallets/wallet'
import { currentMonth, monthLabel, parseBudget, parseBudgetAmount, shiftMonth, type Budget } from './budget'
import { createBudgetService, type SpendRow } from './budgetService'

type BudgetSnapshot = { cats: Category[]; budgets: Budget[]; spend: SpendRow[] }

export function BudgetsPage({ wallet, userId, onBack }: { wallet: Wallet; userId: string; onBack: () => void }) {
  const { items, syncedTick, online, cache } = useOffline()
  const tick0 = useRef(syncedTick) // the first load may show the saved snapshot while revalidating; reloads after a sync or write may not
  const [stale, setStale] = useState(false) // showing the saved snapshot (not confirmed by the server)
  const [checking, setChecking] = useState(false)
  useWatchWallet(wallet.id)
  const seq = useRef(0) // newest load wins
  const service = useMemo(() => (supabase ? createBudgetService(supabase) : null), [])
  const categoryService = useMemo(() => (supabase ? createCategoryService(supabase) : null), [])
  const [month, setMonth] = useState(currentMonth())
  const [categories, setCategories] = useState<Category[] | null>(null)
  const [data, setData] = useState<{ month: string; budgets: Budget[]; spend: SpendRow[] } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState({ categoryId: '', amount: '' })
  const [editing, setEditing] = useState<{ id: string; amount: string } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const isOwner = wallet.role === 'owner' && !stale // UX only; RLS enforces it. Never edit from an unconfirmed snapshot

  const load = useCallback(
    (swr = false) => {
      const n = ++seq.current
      const apply = (r: ReadResult<BudgetSnapshot>) => {
        if (n !== seq.current) return
        setCategories(r.data.cats)
        setData({ month, budgets: r.data.budgets, spend: r.data.spend })
        setStale(r.stale)
        setChecking(!!r.revalidating)
        setLoadError(null)
      }
      return readThrough<BudgetSnapshot>(cache, budgetsKey(userId, wallet.id, month), async () => {
        const [cats, budgets, spend] = await Promise.all([categoryService!.list(wallet.id), service!.list(wallet.id, month), service!.spending(wallet.id, month)])
        return { cats, budgets, spend }
      }, swr ? apply : undefined).then(apply, (e: Error) => n === seq.current && setLoadError(e.message))
    },
    [service, categoryService, wallet.id, month, userId, cache],
  )

  useEffect(() => {
    // offline: readThrough answers from the snapshot without a request (or fails at once when there is none)
    void load(syncedTick === tick0.current)
  }, [load, syncedTick, online]) // syncedTick: a sync finished or Realtime reported a change; online: back on the network

  async function run(action: () => Promise<void>, after: () => void) {
    setBusy(true)
    setFormError(null)
    try {
      await action()
      after()
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const topLevel = (categories ?? []).filter((c) => c.parentId === null).sort((a, b) => a.name.localeCompare(b.name))
  const nameOf = new Map((categories ?? []).map((c) => [c.id, c.name]))
  const loaded = data?.month === month ? data : null // hides the previous month's rows while the next one loads
  // spending = server rows + pending local expenses
  const spent = loaded && categories ? spendingByBudgetCategory(localSpend(loaded.spend, [], items, wallet.id), categories, month) : new Map<string, number>()
  const budgets = [...(loaded?.budgets ?? [])].sort((a, b) => (nameOf.get(a.categoryId) ?? '').localeCompare(nameOf.get(b.categoryId) ?? ''))

  function add(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseBudget({ ...form, month }, topLevel.map((c) => c.id))
    if (!parsed.ok) return setFormError(parsed.error)
    void run(() => service!.create(wallet.id, parsed.value), () => setForm({ categoryId: '', amount: '' }))
  }

  function saveEdit(ev: FormEvent) {
    ev.preventDefault()
    const amount = parseBudgetAmount(editing!.amount)
    if (typeof amount === 'string') return setFormError(amount)
    void run(() => service!.updateAmount(editing!.id, amount), () => setEditing(null))
  }

  function card(b: Budget) {
    const s = calculateBudgetStatus(b.amountMinor, spent.get(b.categoryId) ?? 0)
    const name = nameOf.get(b.categoryId) ?? 'Category'
    return (
      <li key={b.id}>
        <strong>{name}</strong>
        <div>₱{formatMinor(s.spent)} / ₱{formatMinor(s.budget)}</div>
        <progress value={Math.min(s.percentUsed, 100)} max={100} aria-label={`${name} budget used`} />
        <div>
          {s.over ? (
            <span role="alert" className="error">Over budget by ₱{formatMinor(-s.remaining)}</span>
          ) : (
            <>₱{formatMinor(s.remaining)} remaining</>
          )}
          {' · '}{s.percentUsed.toFixed(1)}% used
        </div>
        {isOwner && editing?.id === b.id && (
          <form onSubmit={saveEdit} noValidate>
            <label>
              Budget amount (₱)
              <input inputMode="decimal" value={editing.amount} onChange={(e) => setEditing({ id: b.id, amount: e.target.value })} disabled={busy} />
            </label>
            <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="link" onClick={() => setEditing(null)} disabled={busy}>Cancel</button>
          </form>
        )}
        {isOwner && editing?.id !== b.id && (
          confirmDelete === b.id ? (
            <small>
              Delete this budget? Your transactions and balances are not affected.{' '}
              <button type="button" className="link" disabled={busy} onClick={() => void run(() => service!.remove(b.id), () => setConfirmDelete(null))}>Confirm delete</button>{' '}
              <button type="button" className="link" onClick={() => setConfirmDelete(null)}>Cancel</button>
            </small>
          ) : (
            <>
              <button type="button" className="link" onClick={() => { setEditing({ id: b.id, amount: formatMinor(b.amountMinor) }); setConfirmDelete(null); setFormError(null) }}>Edit</button>{' '}
              <button type="button" className="link" onClick={() => { setConfirmDelete(b.id); setFormError(null) }}>Delete</button>
            </>
          )
        )}
      </li>
    )
  }

  return (
    <section className="card">
      <button type="button" className="link" onClick={onBack}>← Wallets</button>
      <h2>{wallet.name} · Budgets</h2>
      <nav aria-label="Budget month" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <button type="button" className="link" onClick={() => setMonth(shiftMonth(month, -1))}>‹ {monthLabel(shiftMonth(month, -1))}</button>
        <strong aria-current="date">{monthLabel(month)}</strong>
        <button type="button" className="link" onClick={() => setMonth(shiftMonth(month, 1))}>{monthLabel(shiftMonth(month, 1))} ›</button>
      </nav>
      {loadError && online && <p role="alert" className="error">{loadError}</p>}
      {!online && !loaded && <p role="status">Budget data isn't available offline yet. Connect to the internet to see your budgets.</p>}
      {stale && loaded && <p role="status"><small>{staleNote(checking)}</small></p>}
      {!loaded && !loadError && online && <p role="status">Loading budgets…</p>}
      {loaded && budgets.length === 0 && <p>No budgets for {monthLabel(month)}.{isOwner ? ' Create one below.' : ''}</p>}
      {budgets.length > 0 && <ul className="list">{budgets.map(card)}</ul>}
      {formError && <p role="alert" className="error">{formError}</p>}
      {isOwner ? (
        <form onSubmit={add} noValidate>
          <strong>New budget for {monthLabel(month)}</strong>
          <label>
            Category
            <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} disabled={busy}>
              <option value="">Choose a category</option>
              {topLevel.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          <label>
            Month
            <input type="month" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} disabled={busy} />
          </label>
          <label>
            Budget amount (₱)
            <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} disabled={busy} />
          </label>
          <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add Budget'}</button>
        </form>
      ) : stale ? null : (
        <small>Only the wallet owner can manage budgets.</small>
      )}
    </section>
  )
}
