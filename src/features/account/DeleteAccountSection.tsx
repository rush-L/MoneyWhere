import { useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Field } from '../../ui/Field'
import { Section } from '../../ui/Section'
import { useAuth } from '../auth/AuthProvider'
import { loadExport } from '../export/exportService'
import { downloadExport } from '../export/downloadExport'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { createDeletionService, DeletionError, type BlockingWallet, type DeletionPlan } from './deletionService'

const CONFIRM_WORD = 'DELETE'
const PENDING_MESSAGE = 'Sync or discard pending changes first.'
const OFFLINE_MESSAGE = 'Account deletion needs an internet connection.'

type Step =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'blocked'; wallets: BlockingWallet[] }
  | { k: 'summary'; plan: DeletionPlan }
  | { k: 'deleting'; plan: DeletionPlan }
  | { k: 'stop'; message: string }

/** Online only. Deleting is the server's decision; this component only gathers the confirmation and refuses unsafe states early. */
export function DeleteAccountSection({ userId }: { userId: string }) {
  const { online, hasPendingChanges, cache, items } = useOffline()
  const { service: auth } = useAuth()
  const svc = useMemo(() => (supabase ? createDeletionService(supabase) : null), [])
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState<Step>({ k: 'idle' })
  const [typed, setTyped] = useState('')
  const [exporting, setExporting] = useState(false)
  const [note, setNote] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  /** Fresh checks, repeated right before the destructive call: connectivity, then the real IndexedDB outbox (any item, any status). */
  async function unsafe(): Promise<string | null> {
    if (!navigator.onLine) return OFFLINE_MESSAGE
    if (await hasPendingChanges()) return PENDING_MESSAGE
    return null
  }

  async function start() {
    if (!svc) return
    setOpen(true)
    setTyped('')
    setNote(null)
    setStep({ k: 'checking' })
    try {
      const why = await unsafe()
      if (why) return setStep({ k: 'stop', message: why })
      const plan = await svc.preview()
      setStep(plan.blocking.length > 0 ? { k: 'blocked', wallets: plan.blocking } : { k: 'summary', plan })
    } catch (e) {
      setStep({ k: 'stop', message: e instanceof Error ? e.message : 'Could not check your account.' })
    }
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

  async function confirm(plan: DeletionPlan) {
    if (!svc || typed.trim() !== CONFIRM_WORD) return
    setNote(null)
    setStep({ k: 'deleting', plan })
    try {
      const why = await unsafe()
      if (why) return setStep({ k: 'stop', message: why })
      const r = await svc.deleteAccount(plan.willDelete.map((w) => w.id))
      if (!r.ok) {
        if (r.reason === 'blocked') return setStep({ k: 'blocked', wallets: r.wallets })
        setNote({ kind: 'error', text: 'Your wallets changed since you last looked. Review the summary again.' })
        setTyped('')
        return void start()
      }
      // Deleted on the server. Leave this device's session, then drop this user's cached financial snapshots.
      // The outbox was empty (checked above) and is never touched.
      const localCache = cache
      await auth?.signOutLocal().catch((e) => console.error('[account-deletion] local sign-out', e))
      await localCache?.clearUser(userId).catch((e) => console.error('[account-deletion] cache purge', e))
    } catch (e) {
      const unknown = e instanceof DeletionError && e.outcomeUnknown
      setStep({
        k: 'stop',
        message: unknown
          ? "We couldn't confirm whether your account was deleted. Reload the app: if you are signed out, it was deleted; if not, try again."
          : e instanceof Error ? e.message : 'Could not delete your account. Nothing was deleted.',
      })
    }
  }

  const busy = step.k === 'checking' || step.k === 'deleting' || exporting
  return (
    <Section title="Delete account">
      <p className="note">
        Permanently deletes your account and profile. Wallets where you are the only member are deleted with everything in them. In wallets shared with others,
        your transactions stay, shown as &quot;Former member&quot;. This cannot be undone.
      </p>
      {!online && <p role="status" className="note">{OFFLINE_MESSAGE}</p>}
      {items.length > 0 && <p role="status" className="note">{PENDING_MESSAGE}</p>}
      <div className="actions">
        <Button variant="danger" onClick={start} disabled={!online || !supabase || busy}>Delete account…</Button>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} title="Delete your account?" dismissible={!busy}>
        {step.k === 'checking' && <p role="status">Checking your wallets…</p>}
        {step.k === 'stop' && (
          <>
            <p role="alert" className="error">{step.message}</p>
            <div className="actions"><Button variant="secondary" onClick={() => setOpen(false)}>Close</Button></div>
          </>
        )}
        {step.k === 'blocked' && (
          <>
            <p role="alert" className="error">You can&apos;t delete your account while you own a wallet that has other members:</p>
            <ul>
              {step.wallets.map((w) => <li key={w.id}><strong>{w.name}</strong> ({w.otherMembers} other member{w.otherMembers === 1 ? '' : 's'})</li>)}
            </ul>
            <p className="note">In each wallet, open Members, then remove the other members or transfer ownership to one of them. Then try again.</p>
            <div className="actions"><Button variant="secondary" onClick={() => setOpen(false)}>Close</Button></div>
          </>
        )}
        {(step.k === 'summary' || step.k === 'deleting') && (
          <>
            {step.plan.willDelete.length > 0 ? (
              <>
                <p><strong>These wallets, with all their accounts, categories, budgets and transactions, will be permanently deleted:</strong></p>
                <ul>{step.plan.willDelete.map((w) => <li key={w.id}>{w.name}</li>)}</ul>
              </>
            ) : <p>You own no wallets that would be deleted.</p>}
            {step.plan.leaving.length > 0 && (
              <>
                <p>You will be removed from these shared wallets. Their other members keep everything, and your transactions there will show &quot;Former member&quot;:</p>
                <ul>{step.plan.leaving.map((w) => <li key={w.id}>{w.name}</li>)}</ul>
              </>
            )}
            <p>Your profile (name and avatar) is deleted and you are signed out everywhere.</p>
            <div className="actions">
              <Button variant="secondary" onClick={exportFirst} disabled={busy || !online}>{exporting ? 'Exporting…' : 'Export my data first'}</Button>
            </div>
            <Field label={`Type ${CONFIRM_WORD} to confirm`}>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} disabled={busy} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
            </Field>
            {note && <p role={note.kind === 'error' ? 'alert' : 'status'} className={note.kind === 'error' ? 'error' : 'note good'}>{note.text}</p>}
            <div className="actions">
              <Button variant="secondary" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
              <Button variant="danger" onClick={() => confirm(step.plan)} disabled={busy || !online || typed.trim() !== CONFIRM_WORD}>
                {step.k === 'deleting' ? 'Deleting…' : 'Delete my account'}
              </Button>
            </div>
          </>
        )}
      </Dialog>
    </Section>
  )
}
