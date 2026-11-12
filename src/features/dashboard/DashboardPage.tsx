import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { BudgetsPage } from '../budgets/BudgetsPage'
import { currentMonth, monthLabel } from '../budgets/budget'
import { readThrough, walletsKey, type ReadResult } from '../offline/db/cache'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { loadDashboard, projectDashboard } from '../offline/localFinance'
import { staleNote } from '../offline/syncLabels'
import { createWalletService } from '../wallets/walletService'
import type { Wallet } from '../wallets/wallet'
import { attentionAlerts, pickWallet, type DashboardInputs } from './dashboard'
import { createDashboardServiceFor } from './dashboardService'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { BudgetProgress } from '../../ui/BudgetProgress'
import { Money } from '../../ui/Money'
import { PageHeader } from '../../ui/PageHeader'
import { Section } from '../../ui/Section'
import { SummaryCard } from '../../ui/SummaryCard'
import { State } from '../../ui/State'

const KEY = 'moneywhere.dashboardWallet'
const saved = () => {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}
const remember = (id: string) => {
  try {
    localStorage.setItem(KEY, id)
  } catch {
    /* per-viewer convenience only */
  }
}

const NOT_OFFLINE = "Your summary isn't saved on this device yet. Connect to the internet to load it."
const LOAD_FAILED = "We couldn't load your financial summary. Please try again."

export function DashboardPage({ userId }: { userId: string }) {
  const walletService = useMemo(() => (supabase ? createWalletService(supabase) : null), [])
  const { cache, online } = useOffline()
  const [wallets, setWallets] = useState<Wallet[] | null>(null)
  const [walletId, setWalletId] = useState<string | null>(saved)
  const [error, setError] = useState(false)
  const [budgetsOpen, setBudgetsOpen] = useState(false)

  const load = useCallback(
    () => {
      if (!walletService) return
      const apply = (r: ReadResult<Wallet[]>) => { setWallets(r.data); setError(false) }
      return readThrough(cache, walletsKey(userId), () => walletService.list(userId), apply).then(apply, () => setError(true)) // snapshot first, server list replaces it
    },
    [walletService, userId, cache],
  )
  useEffect(() => {
    void load()
  }, [load])

  if (error) return <State kind="error" action={<Button onClick={load}>Retry</Button>}>{online ? LOAD_FAILED : NOT_OFFLINE}</State>
  if (!wallets) return <State kind="loading">Loading…</State>
  const wallet = pickWallet(wallets, walletId)
  if (!wallet) return <><PageHeader title="Dashboard" /><State kind="empty">No wallets yet.<br />Create a wallet to get started.</State></>
  // Remounting DashboardView on return reloads it, so edits made in Budgets show up.
  if (budgetsOpen) return <BudgetsPage wallet={wallet} userId={userId} onBack={() => setBudgetsOpen(false)} />

  return (
    <>
      <PageHeader title="Dashboard" />
      {wallets.length > 1 && (
        <Field label="Wallet">
          <select value={wallet.id} onChange={(e) => { setWalletId(e.target.value); remember(e.target.value) }}>
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
      )}
      <DashboardView key={wallet.id} wallet={wallet} userId={userId} onBudgets={() => setBudgetsOpen(true)} />
    </>
  )
}

function DashboardView({ wallet, userId, onBudgets }: { wallet: Wallet; userId: string; onBudgets: () => void }) {
  const service = useMemo(() => (supabase ? createDashboardServiceFor(supabase) : null), [])
  const month = useMemo(() => currentMonth(), [])
  const { items, syncedTick, cache, online } = useOffline()
  useWatchWallet(wallet.id)
  const seq = useRef(0) // newest load wins: an older fetch resolving late must not overwrite fresher data
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const [snap, setSnap] = useState<DashboardInputs | null>(null)
  const [stale, setStale] = useState(false) // showing the last saved snapshot because the server is unreachable
  const [checking, setChecking] = useState(false) // ...and a background refresh is under way
  const tick0 = useRef(syncedTick) // the first load may show the snapshot while revalidating; reloads after a sync may not
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(
    (initial = false) => {
      const n = ++seq.current
      const apply = (r: ReadResult<DashboardInputs>) => { if (n === seq.current) { setSnap(r.data); setStale(r.stale); setChecking(!!r.revalidating); setError(null) } }
      return service && loadDashboard(cache, service, userId, wallet.id, month, itemsRef.current, initial ? apply : undefined).then(apply, (e: Error) => { if (n === seq.current) setError(e.message) })
    },
    [service, cache, userId, wallet.id, month],
  )
  useEffect(() => {
    void load(syncedTick === tick0.current)
  }, [load, syncedTick]) // syncedTick: a queued transaction just synced, so the server is the baseline now
  // Server baseline + pending outbox items; recomputed live, no refetch when the queue changes.
  const data = useMemo(() => (snap ? projectDashboard(snap, items, wallet.id) : null), [snap, items, wallet.id])
  const retry = () => { setSnap(null); setError(null); void load() }

  if (error) return <State kind="error" action={<Button onClick={retry}>Retry</Button>}>{online ? error : NOT_OFFLINE}</State>
  if (!data) return <State kind="loading">Loading your summary…</State>

  const over = data.totalRemaining < 0
  const alerts = attentionAlerts(data, items, wallet.id)
  return (
    <>
      {stale && <p role="status" className="note">{staleNote(checking)}</p>}
      <p className="period">{monthLabel(month)}</p>
      <div className="summary-grid">
        <SummaryCard label="Budget Remaining" tone={over ? 'over' : undefined} note={<>of <Money minor={data.totalBudgeted} /> budgeted{over && <> · <Badge tone="over">Over budget</Badge></>}</>}>
          <Money minor={data.totalRemaining} />
        </SummaryCard>
        <SummaryCard label="Income" note="This month, transfers excluded"><Money minor={data.monthlyIncome} /></SummaryCard>
        <SummaryCard label="Expenses" note={<><Money minor={data.budgetedSpent} /> in budgeted categories</>}><Money minor={data.totalSpent} /></SummaryCard>
        <SummaryCard label="Total Balance" note={data.accountCount === 0 ? 'No accounts yet. Add an account to start tracking your money.' : `${data.accountCount} account${data.accountCount === 1 ? '' : 's'}`}>
          {data.accountCount === 0 ? '—' : <Money minor={data.totalBalance} />}
        </SummaryCard>
      </div>
      <div className={`dash-cols${alerts.length ? '' : ' solo'}`}>
        {data.budgetCount > 0 && (
          <div className="card">
            <Section title="Budget progress" actions={<Button variant="secondary" onClick={onBudgets}>View budgets</Button>}>
              <ul className="attention">
                {data.attention.map((l) => (
                  <li key={l.categoryId}>
                    <BudgetProgress name={l.name} line={l} />
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}
        {alerts.length > 0 && (
          <div className="card">
            <Section title="Needs attention">
              <ul className="attention">
                {alerts.map((a) => (
                  <li key={a.kind}>
                    {a.kind === 'sync-issue' && <span role="alert" className="error">⚠ {a.count} change{a.count === 1 ? '' : 's'} did not sync. Open Wallets → Transactions for details.</span>}
                    {a.kind === 'pending' && <span>↻ {a.count} transaction change{a.count === 1 ? '' : 's'} waiting to sync. Not saved to the server yet.</span>}
                    {a.kind === 'overspent' && a.lines.map((l) => (
                      <span key={l.categoryId} role="alert" className="error">⚠ {l.name}: {l.remaining === 0 ? 'budget fully used' : <>over budget by <Money minor={-l.remaining} /></>}</span>
                    ))}
                    {a.kind === 'no-budgets' && <><span>No budgets set for this month.</span><Button variant="secondary" onClick={onBudgets}>Go to Budgets</Button></>}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        )}
      </div>
    </>
  )
}
