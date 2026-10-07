import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatMinor } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import { BudgetsPage } from '../budgets/BudgetsPage'
import { currentMonth, monthLabel } from '../budgets/budget'
import { readThrough, walletsKey, type ReadResult } from '../offline/db/cache'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { loadDashboard, projectDashboard } from '../offline/localFinance'
import { staleNote } from '../offline/syncLabels'
import { createWalletService } from '../wallets/walletService'
import type { Wallet } from '../wallets/wallet'
import { pickWallet, type DashboardInputs } from './dashboard'
import { createDashboardServiceFor } from './dashboardService'

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

const peso = (n: number) => `${n < 0 ? '-' : ''}₱${formatMinor(Math.abs(n))}`
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

  if (error) return <section className="card"><p role="alert" className="error">{online ? LOAD_FAILED : NOT_OFFLINE}</p><button type="button" onClick={load}>Retry</button></section>
  if (!wallets) return <section className="card"><p role="status">Loading…</p></section>
  const wallet = pickWallet(wallets, walletId)
  if (!wallet) return <section className="card"><h2>Dashboard</h2><p>No wallets yet.<br />Create a wallet to get started.</p></section>
  // Remounting DashboardView on return reloads it, so edits made in Budgets show up.
  if (budgetsOpen) return <BudgetsPage wallet={wallet} userId={userId} onBack={() => setBudgetsOpen(false)} />

  return (
    <section className="card">
      <h2>Dashboard</h2>
      {wallets.length > 1 && (
        <label>
          Wallet
          <select value={wallet.id} onChange={(e) => { setWalletId(e.target.value); remember(e.target.value) }}>
            {wallets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </label>
      )}
      <DashboardView key={wallet.id} wallet={wallet} userId={userId} onBudgets={() => setBudgetsOpen(true)} />
    </section>
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

  if (error) return <><p role="alert" className="error">{online ? error : NOT_OFFLINE}</p><button type="button" onClick={retry}>Retry</button></>
  if (!data) return <p role="status" aria-busy="true">Loading your summary…</p>

  const over = data.totalRemaining < 0
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
      <strong>{monthLabel(month)}</strong>
      {stale && <p role="status"><small>{staleNote(checking)}</small></p>}
      <div className="stat">
        <small>Total Balance</small>
        {data.accountCount === 0 ? <span>No accounts yet.<br />Add an account to start tracking your money.</span> : <b>{peso(data.totalBalance)}</b>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <div className="stat"><small>Budgeted</small><b>{peso(data.totalBudgeted)}</b></div>
        <div className="stat"><small>Spent</small><b>{peso(data.totalSpent)}</b></div>
      </div>
      <div className="stat">
        <small>Remaining</small>
        <b className={over ? 'error' : undefined}>{peso(data.totalRemaining)}</b>
        {over && <small className="error">Over budget by {peso(-data.totalRemaining)}</small>}
      </div>
      <h3 style={{ margin: 0 }}>Needs Attention</h3>
      {data.budgetCount === 0 ? (
        <p style={{ margin: 0 }}>No budgets for this month. <button type="button" className="link" onClick={onBudgets}>Go to Budgets</button></p>
      ) : (
        <ul className="list" style={{ margin: 0 }}>
          {data.attention.map((l) => (
            <li key={l.categoryId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{l.name}</strong><span>{Math.round(l.percentUsed)}%</span></div>
              <div>{peso(l.spent)} / {peso(l.budget)}</div>
              {l.over ? <span role="alert" className="error">⚠ Over budget by {peso(-l.remaining)}</span> : <small>{peso(l.remaining)} remaining</small>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
