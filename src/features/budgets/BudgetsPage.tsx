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
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { Meter } from '../../ui/Meter'
import { Money } from '../../ui/Money'
import { PageHeader } from '../../ui/PageHeader'
import { State } from '../../ui/State'

type BudgetSnapshot = { cats: Category[]; budgets: Budget[]; spend: SpendRow[] }

/** `onBack` is only passed when the Dashboard opens this page outside the wallet shell; inside the shell the tabs are the navigation. */
export function BudgetsPage({ wallet, userId, onBack }: { wallet: Wallet; userId: string; onBack?: () => void }) {
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
  const [addOpen, setAddOpen] = useState(false) // dialog visibility only; the add form state above stays on this page
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
    void run(() => service!.create(wallet.id, parsed.value), () => { setForm({ categoryId: '', amount: '' }); setAddOpen(false) })
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
      <li key={b.id} className="card budget">
        <strong>{name}</strong>
        <Meter percent={s.percentUsed} over={s.over} label={`${name} budget used`} />
        <div><Money minor={s.spent} /> / <Money minor={s.budget} /></div>
        <div>
          {s.over ? (
            <span role="alert" className="error">Over budget by <Money minor={-s.remaining} /></span>
          ) : (
            <><Money minor={s.remaining} /> remaining</>
          )}
          {' · '}{s.percentUsed.toFixed(1)}% used
        </div>
        {isOwner && editing?.id === b.id && (
          <form onSubmit={saveEdit} noValidate>
            <Field label="Budget amount (₱)">
              <input inputMode="decimal" value={editing.amount} onChange={(e) => setEditing({ id: b.id, amount: e.target.value })} disabled={busy} />
            </Field>
            <div className="actions">
              <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
              <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>Cancel</Button>
            </div>
          </form>
        )}
        {isOwner && editing?.id !== b.id && (
          confirmDelete === b.id ? (
            <>
              <small>Delete this budget? Your transactions and balances are not affected.</small>
              <div className="actions">
                <Button variant="danger" disabled={busy} onClick={() => void run(() => service!.remove(b.id), () => setConfirmDelete(null))}>Confirm delete</Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              </div>
            </>
          ) : (
            <div className="actions">
              <Button variant="secondary" onClick={() => { setEditing({ id: b.id, amount: formatMinor(b.amountMinor) }); setConfirmDelete(null); setFormError(null) }}>Edit</Button>
              <Button variant="ghost" className="text-danger" onClick={() => { setConfirmDelete(b.id); setFormError(null) }}>Delete</Button>
            </div>
          )
        )}
      </li>
    )
  }

  return (
    <>
      <PageHeader
        title={onBack ? `${wallet.name} · Budgets` : 'Budgets'}
        level={onBack ? 1 : 2}
        onBack={onBack}
        backLabel="Dashboard"
        actions={isOwner ? <Button onClick={() => { setFormError(null); setAddOpen(true) }}>+ Add budget</Button> : undefined}
      />
      <nav aria-label="Budget month" className="month-nav">
        <strong aria-current="date">{monthLabel(month)}</strong>
        <Button variant="secondary" onClick={() => setMonth(shiftMonth(month, -1))}>‹ {monthLabel(shiftMonth(month, -1))}</Button>
        <Button variant="secondary" onClick={() => setMonth(shiftMonth(month, 1))}>{monthLabel(shiftMonth(month, 1))} ›</Button>
      </nav>
      {loadError && online && <State kind="error">{loadError}</State>}
      {!online && !loaded && <State kind="empty">Budget data isn't available offline yet. Connect to the internet to see your budgets.</State>}
      {stale && loaded && <p role="status" className="note">{staleNote(checking)}</p>}
      {!loaded && !loadError && online && <State kind="loading">Loading budgets…</State>}
      {loaded && budgets.length === 0 && <State kind="empty">No budgets for {monthLabel(month)}.{isOwner ? ' Use + Add budget to create one.' : ''}</State>}
      {budgets.length > 0 && <ul className="budget-list">{budgets.map(card)}</ul>}
      {formError && !addOpen && <p role="alert" className="error">{formError}</p>}
      {isOwner ? (
        <Dialog open={addOpen} onClose={() => setAddOpen(false)} dismissible={!busy} title={`New budget for ${monthLabel(month)}`}>
          <form onSubmit={add} noValidate>
            <Field label="Category">
              <select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })} disabled={busy}>
                <option value="">Choose a category</option>
                {topLevel.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            <Field label="Month">
              <input type="month" value={month.slice(0, 7)} onChange={(e) => e.target.value && setMonth(`${e.target.value}-01`)} disabled={busy} />
            </Field>
            <Field label="Budget amount (₱)">
              <input inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} disabled={busy} />
            </Field>
            {formError && <p role="alert" className="error">{formError}</p>}
            <Button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Add Budget'}</Button>
          </form>
        </Dialog>
      ) : stale ? null : (
        <p className="note info">Only the wallet owner can manage budgets.</p>
      )}
    </>
  )
}
