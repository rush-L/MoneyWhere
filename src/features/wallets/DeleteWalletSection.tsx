import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { Section } from '../../ui/Section'
import { downloadExport } from '../export/downloadExport'
import { loadExport } from '../export/exportService'
import { walletKey } from '../offline/db/cache'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { DELETE_CONFIRM_WORD, DELETE_PENDING_MESSAGE, hasPendingForWallet, type Wallet } from './wallet'
import { createWalletService } from './walletService'

const OFFLINE_MESSAGE = 'Deleting a wallet needs an internet connection.'

/**
 * Owner only. Online only. The database decides (RLS); this gathers an explicit confirmation and refuses unsafe
 * states early: offline, or queued changes for this wallet on this device (never discarded by this flow).
 */
export function DeleteWalletSection({ wallet, userId, otherMembers, onDeleted }: { wallet: Wallet; userId: string; otherMembers: number; onDeleted: () => void }) {
  const { online, items, cache } = useOffline()
  const itemsRef = useRef(items) // re-read when the delete is confirmed, not as it was when the dialog opened
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const service = useMemo(() => (supabase ? createWalletService(supabase) : null), [])
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  const pending = hasPendingForWallet(items, wallet.id)
  const blocked = !online ? OFFLINE_MESSAGE : pending ? DELETE_PENDING_MESSAGE : null
  const close = () => {
    setOpen(false)
    setTyped('')
    setNote(null)
  }

  async function exportFirst() {
    if (!supabase) return
    setExporting(true)
    setNote(null)
    try {
      downloadExport(await loadExport(supabase, userId))
      setNote({ kind: 'ok', text: 'Your data was exported.' })
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Could not export your data.' })
    } finally {
      setExporting(false)
    }
  }

  async function confirm() {
    if (!service || typed.trim() !== DELETE_CONFIRM_WORD) return
    setNote(null)
    if (!navigator.onLine) return setNote({ kind: 'error', text: OFFLINE_MESSAGE })
    if (hasPendingForWallet(itemsRef.current, wallet.id)) return setNote({ kind: 'error', text: DELETE_PENDING_MESSAGE })
    setBusy(true)
    try {
      await service.remove(wallet.id)
    } catch (e) {
      setNote({ kind: 'error', text: e instanceof Error ? e.message : 'Could not delete the wallet. Nothing was deleted.' })
      setBusy(false)
      return
    }
    await cache?.remove(walletKey(userId, wallet.id)).catch((e) => console.error('[wallets] cache purge', e))
    setBusy(false)
    close()
    onDeleted()
  }

  return (
    <div className="card">
      <Section title="Delete wallet">
        <p className="group-note">
          Permanently deletes this wallet and all its accounts, categories, budgets and transactions
          {otherMembers > 0 ? `, for you and ${otherMembers} other member${otherMembers === 1 ? '' : 's'}` : ''}. This cannot be undone.
        </p>
        {blocked && <p role="status" className="note">{blocked}</p>}
        <div className="actions">
          <Button variant="secondary" className="text-danger" disabled={!!blocked} onClick={() => setOpen(true)}>Delete wallet…</Button>
        </div>
      </Section>
      <Dialog open={open} onClose={close} title={`Delete “${wallet.name}”?`} dismissible={!busy && !exporting}>
        <p><strong>This permanently deletes the wallet with all its accounts, categories, budgets and transactions.</strong></p>
        {otherMembers > 0 && <p>{otherMembers} other member{otherMembers === 1 ? '' : 's'} will lose access immediately and keep nothing. Transactions they have not synced yet may not be saved.</p>}
        <p className="note">Export your data first if you want a copy.</p>
        <div className="actions">
          <Button variant="secondary" onClick={exportFirst} disabled={busy || exporting || !online}>{exporting ? 'Exporting…' : 'Export my data first'}</Button>
        </div>
        <Field label={`Type ${DELETE_CONFIRM_WORD} to confirm`}>
          <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
        </Field>
        {note && <p role={note.kind === 'error' ? 'alert' : 'status'} className={note.kind === 'error' ? 'error' : 'note good'}>{note.text}</p>}
        <div className="actions">
          <Button variant="secondary" onClick={close} disabled={busy || exporting}>Cancel</Button>
          <Button variant="danger" onClick={() => void confirm()} disabled={busy || exporting || !online || pending || typed.trim() !== DELETE_CONFIRM_WORD}>
            {busy ? 'Deleting…' : 'Delete wallet'}
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
