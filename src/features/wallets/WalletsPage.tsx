import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { DEFAULT_CURRENCY, parseWalletName, type Wallet } from './wallet'
import { AccountsPage } from '../accounts/AccountsPage'
import { BudgetsPage } from '../budgets/BudgetsPage'
import { CategoriesPage } from '../categories/CategoriesPage'
import { TransactionsPage } from '../transactions/TransactionsPage'
import { readThrough, walletsKey, type ReadResult } from '../offline/db/cache'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { MembersPanel } from './MembersPanel'
import { createWalletService } from './walletService'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { PageHeader } from '../../ui/PageHeader'
import { Section } from '../../ui/Section'
import { State } from '../../ui/State'

const SECTIONS = [
  ['transactions', 'Transactions'],
  ['accounts', 'Accounts'],
  ['categories', 'Categories'],
  ['budgets', 'Budgets'],
  ['members', 'Members'],
] as const

export function WalletsPage({ userId }: { userId: string }) {
  const service = useMemo(() => (supabase ? createWalletService(supabase) : null), [])
  const { cache } = useOffline()
  const [wallets, setWallets] = useState<Wallet[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ wallet: Wallet; page: 'accounts' | 'categories' | 'transactions' | 'budgets' | 'members' } | null>(null)

  const load = useCallback(
    (initial = false) => {
      if (!service) return
      const apply = (r: ReadResult<Wallet[]>) => {
        setWallets(r.data) // offline: last saved list, so a queued transaction stays reachable
        setLoadError(null)
      }
      // first load: snapshot at once, server list replaces it; after create/delete the server list is required
      return readThrough(cache, walletsKey(userId), () => service.list(userId), initial ? apply : undefined).then(apply, (e: Error) => setLoadError(e.message))
    },
    [service, userId, cache],
  )

  useEffect(() => {
    void load(true)
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
    // Presentation only: exactly one section is mounted at a time, so switching tabs remounts and reloads it like before.
    const { wallet } = selected
    const section =
      selected.page === 'transactions' ? <TransactionsPage wallet={wallet} userId={userId} />
      : selected.page === 'budgets' ? <BudgetsPage wallet={wallet} userId={userId} />
      : selected.page === 'accounts' ? <AccountsPage wallet={wallet} userId={userId} />
      : selected.page === 'members' ? <MembersPanel wallet={wallet} userId={userId} onLeft={() => { setSelected(null); void load() }} />
      : <CategoriesPage wallet={wallet} userId={userId} />
    return (
      <div className="wallet-shell">
        <PageHeader title={wallet.name} onBack={back} backLabel="Wallets" />
        <nav className="tabs" aria-label={`${wallet.name} sections`}>
          {SECTIONS.map(([page, label]) => (
            <button key={page} type="button" aria-current={selected.page === page ? 'page' : undefined} onClick={() => selected.page !== page && setSelected({ wallet, page })}>
              {label}
            </button>
          ))}
        </nav>
        {section}
      </div>
    )
  }

  return (
    <>
      <PageHeader title="Wallets" />
      {loadError && <State kind="error">{loadError}</State>}
      {!wallets && !loadError && <State kind="loading">Loading wallets…</State>}
      {wallets?.length === 0 && <State kind="empty">No wallets yet. Create your first one below.</State>}
      {wallets && wallets.length > 0 && (
        <ul className="wallet-list">
          {wallets.map((w) => (
            <li key={w.id} className="card wallet-row">
              <div className="wallet-id">
                <strong>{w.name}</strong>
                <span className="wallet-meta">
                  <Badge>{w.currency}</Badge>
                  <Badge tone={w.role === 'owner' ? 'info' : 'neutral'}>{w.role === 'owner' ? 'Owner' : 'Member'}</Badge>
                </span>
              </div>
              <Button onClick={() => setSelected({ wallet: w, page: 'transactions' })} aria-label={`Open ${w.name}`}>Open</Button>
            </li>
          ))}
        </ul>
      )}
      <div className="card">
        <Section title="New wallet">
          <form onSubmit={create} noValidate>
            <Field label="Wallet name" error={formError} hint={`Currency: ${DEFAULT_CURRENCY} (one currency per wallet)`}>
              <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} disabled={creating} />
            </Field>
            <Button type="submit" disabled={creating}>{creating ? 'Creating…' : 'Create Wallet'}</Button>
          </form>
        </Section>
      </div>
    </>
  )
}
