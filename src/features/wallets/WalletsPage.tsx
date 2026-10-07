import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { DEFAULT_CURRENCY, parseWalletName, type Wallet } from './wallet'
import { AccountsPage } from '../accounts/AccountsPage'
import { BudgetsPage } from '../budgets/BudgetsPage'
import { CategoriesPage } from '../categories/CategoriesPage'
import { TransactionsPage } from '../transactions/TransactionsPage'
import { readThrough, walletsKey } from '../offline/db/cache'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { createWalletService } from './walletService'

export function WalletsPage({ userId }: { userId: string }) {
  const service = useMemo(() => (supabase ? createWalletService(supabase) : null), [])
  const { cache } = useOffline()
  const [wallets, setWallets] = useState<Wallet[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ wallet: Wallet; page: 'accounts' | 'categories' | 'transactions' | 'budgets' } | null>(null)

  const load = useCallback(
    () =>
      service && readThrough(cache, walletsKey(userId), () => service.list(userId)).then(
        (r) => {
          setWallets(r.data) // offline: last saved list, so a queued transaction stays reachable
          setLoadError(null)
        },
        (e: Error) => setLoadError(e.message),
      ),
    [service, userId, cache],
  )

  useEffect(() => {
    void load()
  }, [load])

  async function create(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseWalletName(name)
    if (!parsed.ok) return setFormError(parsed.error)
    setCreating(true)
    setFormError(null)
    try {
      await service!.create(parsed.name)
      setName('')
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not create the wallet.')
    } finally {
      setCreating(false)
    }
  }

  if (selected) {
    const back = () => setSelected(null)
    if (selected.page === 'transactions') return <TransactionsPage wallet={selected.wallet} userId={userId} onBack={back} />
    if (selected.page === 'budgets') return <BudgetsPage wallet={selected.wallet} onBack={back} />
    if (selected.page === 'accounts') return <AccountsPage wallet={selected.wallet} userId={userId} onBack={back} />
    return <CategoriesPage wallet={selected.wallet} onBack={back} />
  }

  return (
    <section className="card">
      <h2>Wallets</h2>
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {!wallets && !loadError && <p role="status">Loading wallets…</p>}
      {wallets?.length === 0 && <p>No wallets yet. Create your first one below.</p>}
      {wallets && wallets.length > 0 && (
        <ul className="list">
          {wallets.map((w) => (
            <li key={w.id}>
              <strong>{w.name}</strong> <small>{w.currency} · {w.role}</small>{' '}
              <button type="button" className="link" onClick={() => setSelected({ wallet: w, page: 'transactions' })}>Transactions</button>{' '}
              <button type="button" className="link" onClick={() => setSelected({ wallet: w, page: 'accounts' })}>Accounts</button>{' '}
              <button type="button" className="link" onClick={() => setSelected({ wallet: w, page: 'categories' })}>Categories</button>{' '}
              <button type="button" className="link" onClick={() => setSelected({ wallet: w, page: 'budgets' })}>Budgets</button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={create} noValidate>
        <label>
          New wallet name
          <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} disabled={creating} />
        </label>
        <small>Currency: {DEFAULT_CURRENCY} (one currency per wallet)</small>
        {formError && <p role="alert" className="error">{formError}</p>}
        <button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create Wallet'}</button>
      </form>
    </section>
  )
}
