import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { calculateBudgetStatus, formatMinor, spendingByBudgetCategory } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import type { Category } from '../categories/category'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { localSpend } from '../offline/outbox/projection'
import { createCategoryService } from '../categories/categoryService'
import type { Wallet } from '../wallets/wallet'
import { currentMonth, monthLabel, parseBudget, parseBudgetAmount, shiftMonth, type Budget } from './budget'
import { createBudgetService, type SpendRow } from './budgetService'

export function BudgetsPage({ wallet, onBack }: { wallet: Wallet; onBack: () => void }) {
  const { items, syncedTick, online } = useOffline()
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
  const isOwner = wallet.role === 'owner' // UX only; RLS enforces it

  const load = useCallback(
    () => {
      const n = ++seq.current
      return Promise.all([categoryService!.list(wallet.id), service!.list(wallet.id, month), service!.spending(wallet.id, month)]).then(
        ([cats, budgets, spend]) => {
          if (n !== seq.current) return
          setCategories(cats)
          setData({ month, budgets, spend })
          setLoadError(null)
        },
        (e: Error) => n === seq.current && setLoadError(e.message),
      )
    },
    [service, categoryService, wallet.id, month],
  )

  useEffect(() => {
    if (online) void load() // offline: budgets have no saved copy, and a request could only fail slowly
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
      {!online && loaded && <p role="status"><small>You're offline. These figures are from when this page was last loaded and may be out of date.</small></p>}
      {!loaded && !loadError && online && <p role="status">Loading budgets…</p>}
      {loaded && budgets.length === 0 && <p>No budgets for {monthLabel(month)}.{isOwner ? ' Create one below.' : ''}</p>}
      {budgets.length > 0 && <ul className="list">{budgets.map(card)}</ul>}
      {formError && <p role="alert" className="error">{formError}</p>}
      {!online && !loaded ? null : isOwner ? (
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
      ) : (
        <small>Only the wallet owner can manage budgets.</small>
      )}
    </section>
  )
}
