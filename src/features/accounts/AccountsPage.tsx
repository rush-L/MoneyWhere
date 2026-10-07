import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatMinor } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import type { ReadResult } from '../offline/db/cache'
import { loadAccounts, projectAccounts, type AccountsSnapshot } from '../offline/localFinance'
import { staleNote } from '../offline/syncLabels'
import { createTransactionService } from '../transactions/transactionService'
import type { Wallet } from '../wallets/wallet'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, parseNewAccount, type Account } from './account'
import { createAccountService } from './accountService'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { Money } from '../../ui/Money'
import { PageHeader } from '../../ui/PageHeader'
import { State } from '../../ui/State'

const EMPTY = { name: '', type: 'cash', openingBalance: '', holder: '' }

export function AccountsPage({ wallet, userId }: { wallet: Wallet; userId: string }) {
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
  const [checking, setChecking] = useState(false) // ...and a background refresh is under way
  const tick0 = useRef(syncedTick) // the first load may show the snapshot while revalidating; reloads after a sync may not
  const [loadError, setLoadError] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY)
  const [editing, setEditing] = useState<Account | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [creating, setCreating] = useState(false) // true while saving (create or edit)
  const [formError, setFormError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false) // dialog visibility only; the form state above stays on this page
  const isOwner = wallet.role === 'owner' // UX only; RLS enforces it

  const load = useCallback(
    (initial = false) => {
      const n = ++seq.current
      const apply = (r: ReadResult<AccountsSnapshot>) => {
        if (n !== seq.current) return
        setSnap(r.data)
        setStale(r.stale)
        setChecking(!!r.revalidating)
        setLoadError(null)
      }
      return (
        service &&
        txService &&
        loadAccounts(cache, { accounts: service, tx: txService }, userId, wallet.id, itemsRef.current, initial ? apply : undefined).then(
          apply,
          (e: Error) => n === seq.current && setLoadError(e.message),
        )
      )
    },
    [service, txService, cache, userId, wallet.id],
  )

  useEffect(() => {
    void load(syncedTick === tick0.current)
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
      setFormOpen(false)
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
    setFormOpen(true)
    setForm({ name: a.name, type: a.type, openingBalance: formatMinor(a.openingBalanceMinor), holder: a.holder ?? '' })
  }
  function cancelEdit() {
    setEditing(null)
    setFormError(null)
    setForm(EMPTY)
    setFormOpen(false)
  }
  // Closing the dialog cancels an edit (as Cancel did); a half-typed new account is kept, as the inline form kept it.
  function closeForm() {
    if (editing) cancelEdit()
    else setFormOpen(false)
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
    <>
      <PageHeader
        title="Accounts"
        actions={isOwner ? <Button onClick={() => { setFormError(null); setFormOpen(true) }}>+ Add account</Button> : undefined}
      />
      {loadError && <State kind="error">{loadError}</State>}
      {stale && <p role="status" className="note">{staleNote(checking)}</p>}
      {!accounts && !loadError && <State kind="loading">Loading accounts…</State>}
      {accounts?.length === 0 && <State kind="empty">No accounts yet.{isOwner ? ' Use + Add account to create your first one.' : ''}</State>}
      {accounts && accounts.length > 0 && (
        <ul className="account-list">
          {accounts.map((a) => (
            <li key={a.id} className="card account">
              <div className="account-top">
                <strong>{a.name}</strong>
                <Badge>{ACCOUNT_TYPE_LABELS[a.type]}</Badge>
              </div>
              {a.holder && <small>Holder: {a.holder}</small>}
              <div className="account-balance">
                <small>Current balance</small>
                <b><Money minor={a.currentBalanceMinor} /></b>
              </div>
              <small>Opening balance <Money minor={a.openingBalanceMinor} /></small>
              {a.hasTransactions && <Badge tone="info">Has transactions</Badge>}
              {isOwner && a.hasTransactions && <small>Its type and opening balance are locked, and it can't be deleted.</small>}
              {isOwner && (
                <div className="actions">
                  <Button variant="secondary" onClick={() => startEdit(a)}>Edit</Button>
                  {!a.hasTransactions &&
                    (confirmDelete === a.id ? (
                      <>
                        <Button variant="danger" onClick={() => void remove(a)}>Confirm delete</Button>
                        <Button variant="ghost" onClick={() => setConfirmDelete(null)}>Cancel</Button>
                      </>
                    ) : (
                      <Button variant="ghost" className="text-danger" onClick={() => setConfirmDelete(a.id)}>Delete</Button>
                    ))}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {isOwner ? (
        <Dialog open={formOpen} onClose={closeForm} dismissible={!creating} title={editing ? `Edit ${editing.name}` : 'New account'}>
          <form onSubmit={(e) => void save(e)} noValidate>
            <Field label="Account name"><input value={form.name} maxLength={50} onChange={set('name')} disabled={creating} /></Field>
            <Field label="Type" hint={locked ? 'Locked: this account has transactions.' : undefined}>
              <select value={form.type} onChange={set('type')} disabled={creating || locked}>
                {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
              </select>
            </Field>
            <Field label="Opening balance (₱)" hint={locked ? 'Locked: this account has transactions.' : undefined}>
              <input inputMode="decimal" value={form.openingBalance} placeholder="0.00" onChange={set('openingBalance')} disabled={creating || locked} />
            </Field>
            <Field label="Holder (optional)"><input value={form.holder} maxLength={50} onChange={set('holder')} disabled={creating} /></Field>
            <small>Currency: {wallet.currency} (same as the wallet)</small>
            {locked && <small>This account has transactions, so only its name and holder can change.</small>}
            {formError && <p role="alert" className="error">{formError}</p>}
            <Button type="submit" disabled={creating}>{creating ? 'Saving…' : editing ? 'Save Changes' : 'Create Account'}</Button>
          </form>
        </Dialog>
      ) : (
        <p className="note info">Only the wallet owner can add accounts.</p>
      )}
    </>
  )
}
