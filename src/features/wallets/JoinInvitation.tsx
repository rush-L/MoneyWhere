import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Button } from '../../ui/Button'
import { PageHeader } from '../../ui/PageHeader'
import { State } from '../../ui/State'
import { createMembershipService, type InvitationPreview } from './membershipService'

type View =
  | { kind: 'checking' }
  | { kind: 'error'; message: string }
  | { kind: 'invalid' }
  | { kind: 'ready'; walletName: string; alreadyMember: boolean }
  | { kind: 'joined'; walletName: string; joined: boolean }

/**
 * Opened from a `#/join/<token>` link by a signed-in user. The token lives only in this component (and the URL
 * fragment until `onClose`); it is never stored. Every failure shows the same message, so an invalid, expired,
 * revoked or used link cannot be told apart.
 */
export function JoinInvitation({ token, onClose }: { token: string; onClose: (goToWallets: boolean) => void }) {
  const service = useMemo(() => (supabase ? createMembershipService(supabase) : null), [])
  const [view, setView] = useState<View>({ kind: 'checking' })
  const [busy, setBusy] = useState(false)
  const asked = useRef<string | null>(null) // one check per token (also under StrictMode); each check counts toward the rate limit

  useEffect(() => {
    if (!service || asked.current === token) return
    asked.current = token
    service.previewInvitation(token).then(
      (p: InvitationPreview) => setView(p.valid ? { kind: 'ready', walletName: p.walletName, alreadyMember: p.alreadyMember } : { kind: 'invalid' }),
      (e: Error) => setView({ kind: 'error', message: e.message }),
    )
  }, [service, token])

  async function accept(walletName: string) {
    setBusy(true)
    try {
      const r = await service!.acceptInvitation(token)
      setView(r.ok ? { kind: 'joined', walletName, joined: r.joined } : { kind: 'invalid' })
    } catch (e) {
      setView({ kind: 'error', message: e instanceof Error ? e.message : 'Could not accept the invitation.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader title="Wallet invitation" />
      <div className="card">
        {view.kind === 'checking' && <State kind="loading">Checking your invitation…</State>}
        {view.kind === 'error' && <State kind="error" action={<Button variant="secondary" onClick={() => onClose(false)}>Close</Button>}>{view.message}</State>}
        {view.kind === 'invalid' && (
          <State kind="error" action={<Button variant="secondary" onClick={() => onClose(false)}>Close</Button>}>
            This invitation is not valid. It may have expired, been used, or been revoked. Ask the wallet owner for a new link.
          </State>
        )}
        {view.kind === 'ready' && (
          <>
            <p>
              {view.alreadyMember ? <>You are already a member of <strong>{view.walletName}</strong>.</> : <>You have been invited to join <strong>{view.walletName}</strong> as a member.</>}
            </p>
            <div className="actions">
              {view.alreadyMember ? (
                <Button onClick={() => onClose(true)}>Go to wallets</Button>
              ) : (
                <Button disabled={busy} onClick={() => accept(view.walletName)}>{busy ? 'Joining…' : 'Join wallet'}</Button>
              )}
              <Button variant="secondary" disabled={busy} onClick={() => onClose(false)}>Not now</Button>
            </div>
          </>
        )}
        {view.kind === 'joined' && (
          <>
            <p role="status" className="note good">{view.joined ? <>You joined <strong>{view.walletName}</strong>.</> : <>You are already a member of <strong>{view.walletName}</strong>.</>}</p>
            <Button onClick={() => onClose(true)}>Go to wallets</Button>
          </>
        )}
      </div>
    </>
  )
}
