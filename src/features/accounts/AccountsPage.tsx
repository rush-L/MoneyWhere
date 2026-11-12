import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { formatMinor } from '../../domain/finance'
import { supabase } from '../../lib/supabase'
import { useOffline, useWatchWallet } from '../offline/hooks/OfflineProvider'
import type { ReadResult } from '../offline/db/cache'
import { loadAccounts, pendingAccountUse, projectAccounts, type AccountsSnapshot } from '../offline/localFinance'
import { staleNote, syncCounts } from '../offline/syncLabels'
import { createTransactionService } from '../transactions/transactionService'
import type { Wallet } from '../wallets/wallet'
import { ACCOUNT_TYPES, ACCOUNT_TYPE_LABELS, accountLock, canManageAccounts, CREDIT_GROUP_NOTE, DELETE_NOTE, lockNote, ACCOUNT_GROUP_LABELS, groupAccounts, isCreditType, parseNewAccount, type Account } from './account'
import { AccountCard } from './AccountCard'
import { createAccountService } from './accountService'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
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
  const isOwner = canManageAccounts(wallet.role, stale) // UX only; RLS enforces it. Never offered from an unconfirmed snapshot

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

  // Accounts that queued transactions use. They count as used, so type/opening balance stay locked and delete is off.
  const pendingUse = useMemo(() => (snap ? pendingAccountUse(snap, items, wallet.id) : new Set<string>()), [snap, items, wallet.id])
  const unsynced = syncCounts(items, wallet.id).counted // already inside the balances above

  function openAdd() {
    setFormError(null)
    setFormOpen(true)
  }

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseNewAccount(form)
    if (!parsed.ok) return setFormError(parsed.error)
    setCreating(true)
    setFormError(null)
    try {
      if (editing) await service!.update({ ...editing, hasTransactions: accountLock(editing, pendingUse).locked }, parsed.value) // same payload rules; pending use counts as used
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
    // Checked again at click time against the latest queue: a transaction may have been queued since the button rendered.
    const now = snap ? pendingAccountUse(snap, itemsRef.current, wallet.id) : new Set<string>()
    if (accountLock(a, now).pendingOnly) {
      setLoadError("This account can't be deleted yet: transactions waiting to sync use it.")
      return
    }
    try {
      await service!.remove(a)
      if (editing?.id === a.id) cancelEdit()
      await load()
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not delete the account.')
    }
  }

  const lock = editing ? accountLock(editing, pendingUse) : null
  const locked = lock?.locked ?? false
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })

  function card(a: Account) {
    const l = accountLock(a, pendingUse)
    return (
      <AccountCard key={a.id} account={a} pendingOnly={l.pendingOnly}>
        {isOwner && l.locked && (
          <small>{lockNote(l.pendingOnly)} {l.pendingOnly ? DELETE_NOTE.pending : DELETE_NOTE.server}</small>
        )}
        {isOwner && (
          <div className="actions">
            <Button variant="secondary" onClick={() => startEdit(a)}>Edit</Button>
            {l.canDelete &&
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
      </AccountCard>
    )
  }

  return (
    <>
      <PageHeader
        title="Accounts"
        level={2}
        actions={isOwner ? <Button className="add-desktop" onClick={openAdd}>+ Add account</Button> : undefined}
      />
      {isOwner && <button type="button" className="fab" aria-label="Add account" onClick={openAdd}>+</button>}
      {loadError && <State kind="error">{loadError}</State>}
      {stale && <p role="status" className="note">{staleNote(checking)}</p>}
      {!accounts && !loadError && <State kind="loading">Loading accounts…</State>}
      {accounts?.length === 0 && (
        <State kind="empty" action={isOwner ? <Button onClick={openAdd}>Add your first account</Button> : undefined}>No accounts yet.</State>
      )}
      {accounts && accounts.length > 0 && (
        <>
          {unsynced > 0 && <p role="status" className="note info">Balances include {unsynced} transaction change{unsynced === 1 ? '' : 's'} not yet saved to the server.</p>}
          <div className="account-groups">
            {groupAccounts(accounts).map((g) => (
              <section key={g.id} className="account-group" aria-label={g.label}>
                <h3 className="group-head">{g.label} <small>· {g.accounts.length} account{g.accounts.length === 1 ? '' : 's'}</small></h3>
                {g.id === 'credit_loans' && <p className="group-note">{CREDIT_GROUP_NOTE}</p>}
                <ul className="account-list">{g.accounts.map(card)}</ul>
              </section>
            ))}
          </div>
        </>
      )}
      {isOwner ? (
        <Dialog open={formOpen} onClose={closeForm} dismissible={!creating} title={editing ? `Edit ${editing.name}` : 'New account'}>
          <form onSubmit={(e) => void save(e)} noValidate>
            <Field label="Account name"><input value={form.name} maxLength={50} onChange={set('name')} disabled={creating} /></Field>
            <Field label="Type">
              <select value={form.type} onChange={set('type')} disabled={creating || locked}>
                <optgroup label={ACCOUNT_GROUP_LABELS.cash_bank}>
                  {ACCOUNT_TYPES.filter((t) => !isCreditType(t)).map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
                </optgroup>
                <optgroup label={ACCOUNT_GROUP_LABELS.credit_loans}>
                  {ACCOUNT_TYPES.filter(isCreditType).map((t) => <option key={t} value={t}>{ACCOUNT_TYPE_LABELS[t]}</option>)}
                </optgroup>
              </select>
            </Field>
            <Field label="Opening balance (₱)">
              <input className="amount-input" inputMode="decimal" value={form.openingBalance} placeholder="0.00" onChange={set('openingBalance')} disabled={creating || locked} />
            </Field>
            <Field label="Holder (optional)"><input value={form.holder} maxLength={50} onChange={set('holder')} disabled={creating} /></Field>
            <small>Currency: {wallet.currency} (same as the wallet)</small>
            {locked && <small>{lockNote(!!lock?.pendingOnly)} Name and holder can still be changed.</small>}
            {formError && <p role="alert" className="error">{formError}</p>}
            <Button type="submit" disabled={creating}>{creating ? 'Saving…' : editing ? 'Save Changes' : 'Create Account'}</Button>
          </form>
        </Dialog>
      ) : stale ? null : (
        <p className="note info">Only the wallet owner can add accounts.</p>
      )}
    </>
  )
}
