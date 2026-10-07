import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatMinor } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import { loadAccounts, projectAccounts, type AccountsSnapshot } from '../offline/localFinance'
import { createTransactionService } from '../transactions/transactionService'
import type { Wallet } from '../wallets/wallet'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, parseNewAccount, type Account } from './account'
import { createAccountService } from './accountService'

const EMPTY = { name: '', type: 'cash', openingBalance: '', holder: '' }

export function AccountsPage({ wallet, userId, onBack }: { wallet: Wallet; userId: string; onBack: () => void }) {
  const service = useMemo(() => (supabase ? createAccountService(supabase) : null), [])
  const txService = useMemo(() => (supabase ? createTransactionService(supabase) : null), [])
  const { items, syncedTick, cache } = useOffline()
  useWatchWallet(wallet.id)
  const seq = useRef(0) // newest load wins
  const itemsRef = useRef(items)
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const [snap, setSnap] = useState<AccountsSnapshot | null>(null)
  const [stale, setStale] = useState(false) // showing the last saved snapshot because the server is unreachable
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [editing, setEditing] = useState<Account | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creating, setCreating] = useState(false) // true while saving (create or edit)
  const [formError, setFormError] = useState<string | null>(null)
  const isOwner = wallet.role === 'owner' // UX only; RLS enforces it

  const load = useCallback(
    () => {
      const n = ++seq.current
      return (
        service &&
        txService &&
        loadAccounts(cache, { accounts: service, tx: txService }, userId, wallet.id, itemsRef.current).then(
          (r) => {
            if (n !== seq.current) return
            setSnap(r.data)
            setStale(r.stale)
            setLoadError(null)
          },
          (e: Error) => n === seq.current && setLoadError(e.message),
        )
      )
    },
    [service, txService, cache, userId, wallet.id],
  )

  useEffect(() => {
    void load()
  }, [load, syncedTick]) // syncedTick: a queued transaction just synced, so the server is the baseline now
  // Server baseline + pending outbox items (the same projection the Dashboard and Transactions use).
  const accounts = useMemo(() => (snap ? projectAccounts(snap, items, wallet.id) : null), [snap, items, wallet.id])

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseNewAccount(form)
    if (!parsed.ok) return setFormError(parsed.error)
    setCreating(true)
    setFormError(null)
    try {
      if (editing) await service!.update(editing, parsed.value)
      else await service!.create(wallet.id, parsed.value)
      setEditing(null)
      setForm(EMPTY)
      await load()
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Could not save the account.')
    } finally {
      setCreating(false)
    }
  }

  function startEdit(a: Account) {
    setEditing(a)
    setFormError(null)
    setForm({ name: a.name, type: a.type, openingBalance: formatMinor(a.openingBalanceMinor), holder: a.holder ?? '' })
  }
  function cancelEdit() {
    setEditing(null)
    setFormError(null)
    setForm(EMPTY)
  }
  async function remove(a: Account) {
    setConfirmDelete(null)
    try {
      await service!.remove(a)
      if (editing?.id === a.id) cancelEdit()
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not delete the account.')
    }
  }

  const locked = editing?.hasTransactions ?? false
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  return (
    <section className="card">
      <button type="button" className="link" onClick={onBack}>← Wallets</button>
      <h2>{wallet.name} · Accounts</h2>
      {loadError && <p role="alert" className="error">{loadError}</p>}
      {stale && <p role="status"><small>Showing data saved on this device. Reconnect to refresh.</small></p>}
      {!accounts && !loadError && <p role="status">Loading accounts…</p>}
      {accounts?.length === 0 && <p>No accounts yet.{isOwner ? ' Create your first one below.' : ''}</p>}
      {accounts && accounts.length > 0 && (
        <ul className="list">
          {accounts.map((a) => (
            <li key={a.id}>
              <strong>{a.name}</strong>{' '}
              <small>{ACCOUNT_TYPE_LABELS[a.type]}{a.holder ? ` · Holder: ${a.holder}` : ''}</small>
              <br />
              <small>Opening ₱{formatMinor(a.openingBalanceMinor)} · Current ₱{formatMinor(a.currentBalanceMinor)}</small>
              {isOwner && (
                <>
                  <br />
                  <button type="button" className="link" onClick={() => startEdit(a)}>Edit</button>
                  {!a.hasTransactions &&
                    (confirmDelete === a.id ? (
                      <>
                        {' '}<button type="button" className="link" onClick={() => void remove(a)}>Confirm delete</button>
                        {' '}<button type="button" className="link" onClick={() => setConfirmDelete(null)}>Cancel</button>
                      </>
                    ) : (
                      <>{' '}<button type="button" className="link" onClick={() => setConfirmDelete(a.id)}>Delete</button></>
                    ))}
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {isOwner ? (
        <form onSubmit={(e) => void save(e)} noValidate>
          <strong>{editing ? `Edit ${editing.name}` : 'New account'}</strong>
          <label>Account name<input value={form.name} maxLength={50} onChange={set('name')} disabled={creating} /></label>
          <label>
            Type
            <select value={form.type} onChange={set('type')} disabled={creating || locked}>
              {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
            </select>
          </label>
          <label>
            Opening balance (₱)
            <input inputMode="decimal" value={form.openingBalance} placeholder="0.00" onChange={set('openingBalance')} disabled={creating || locked} />
          </label>
          <label>Holder (optional)<input value={form.holder} maxLength={50} onChange={set('holder')} disabled={creating} /></label>
          <small>Currency: {wallet.currency} (same as the wallet)</small>
          {locked && <small>This account has transactions, so only its name and holder can change.</small>}
          {formError && <p role="alert" className="error">{formError}</p>}
          <button type="submit" disabled={creating}>{creating ? 'Saving…' : editing ? 'Save Changes' : 'Create Account'}</button>
          {editing && <button type="button" className="link" onClick={cancelEdit} disabled={creating}>Cancel</button>}
        </form>
      ) : (
        <small>Only the wallet owner can add accounts.</small>
      )}
    </section>
  )
}
