import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { Section } from '../../ui/Section'
import { State } from '../../ui/State'
import { INVITE_DAYS, inviteLink, memberLabels, type CreatedInvitation, type Member, type PendingInvitation } from './membership'
import { createMembershipService } from './membershipService'
import type { Wallet } from './wallet'

const day = (iso: string) => new Date(iso).toLocaleDateString()

/**
 * Members and invitations for one wallet. Online only: membership changes are never queued offline.
 * Authorization is the database's; the owner-only controls here just mirror it.
 */
export function MembersPanel({ wallet, userId, onLeft }: { wallet: Wallet; userId: string; onLeft: () => void }) {
  const service = useMemo(() => (supabase ? createMembershipService(supabase) : null), [])
  const isOwner = wallet.role === 'owner'
  const [members, setMembers] = useState<Member[] | null>(null)
  const [invites, setInvites] = useState<PendingInvitation[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedInvitation | null>(null) // in memory only; the link is shown once
  const [copied, setCopied] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)

  const load = useCallback(() => {
    if (!service) return Promise.resolve()
    return Promise.all([service.listMembers(wallet.id), isOwner ? service.listInvitations(wallet.id) : Promise.resolve([])]).then(
      ([m, i]) => {
        setMembers(m)
        setInvites(i)
        setLoadError(null)
      },
      (e: Error) => setLoadError(e.message),
    )
  }, [service, wallet.id, isOwner])
  useEffect(() => {
    void load()
  }, [load])

  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const link = created ? inviteLink(window.location.origin, created.token) : ''
  const labels = members ? memberLabels(members, userId) : new Map<string, string>()

  if (loadError) return <State kind="error" action={<Button onClick={() => void load()}>Retry</Button>}>{loadError}</State>
  if (!members) return <State kind="loading">Loading members…</State>

  return (
    <>
      <p className="note info">Membership changes need an internet connection.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="card">
        <Section title="Members">
          <ul className="wallet-list">
            {members.map((m) => (
              <li key={m.userId} className="wallet-row">
                <div className="wallet-id">
                  <strong>{labels.get(m.userId)}</strong>
                  <span className="wallet-meta">
                    <Badge tone={m.role === 'owner' ? 'info' : 'neutral'}>{m.role === 'owner' ? 'Owner' : 'Member'}</Badge>
                    <small>Joined {day(m.joinedAt)}</small>
                  </span>
                </div>
                {isOwner && m.role === 'member' && (
                  <Button variant="danger" disabled={busy} onClick={() => setRemoving(m.userId)} aria-label={`Remove ${labels.get(m.userId)}`}>Remove</Button>
                )}
              </li>
            ))}
          </ul>
          {!isOwner && <Button variant="secondary" disabled={busy} onClick={() => setLeaving(true)}>Leave wallet</Button>}
        </Section>
      </div>

      {isOwner && (
        <div className="card">
          <Section title="Invite link">
            <p>Create a link and share it with the person you want to invite. It works once and expires in {INVITE_DAYS} days.</p>
            <Button
              disabled={busy}
              onClick={() => act(async () => {
                setCreated(await service!.createInvitation(wallet.id))
                setCopied(false)
                await load()
              })}
            >
              Create invite link
            </Button>
            {created && (
              <div role="status">
                <p className="note good">Copy this link now. For security it cannot be shown again.</p>
                <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.currentTarget.select()} />
                <div className="actions">
                  <Button
                    variant="secondary"
                    onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true), () => setError('Could not copy. Select the link and copy it manually.'))}
                  >
                    {copied ? 'Copied' : 'Copy link'}
                  </Button>
                  <Button variant="ghost" onClick={() => setCreated(null)}>Done</Button>
                </div>
              </div>
            )}
            <h3>Pending invitations</h3>
            {invites.length === 0 ? (
              <State kind="empty">No pending invitations.</State>
            ) : (
              <ul className="wallet-list">
                {invites.map((i) => (
                  <li key={i.id} className="wallet-row">
                    <span>Created {day(i.createdAt)} · expires {day(i.expiresAt)}</span>
                    <Button variant="secondary" disabled={busy} onClick={() => act(async () => { await service!.revokeInvitation(i.id); if (created?.id === i.id) setCreated(null); await load() })}>
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      <Dialog open={removing !== null} onClose={() => setRemoving(null)} title="Remove member?" dismissible={!busy}>
        <p>{removing ? labels.get(removing) : ''} will lose access to this wallet immediately. Their past transactions stay in the wallet.</p>
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => act(async () => { await service!.removeMember(wallet.id, removing!); setRemoving(null); await load() })}>Remove member</Button>
        </div>
      </Dialog>
      <Dialog open={leaving} onClose={() => setLeaving(false)} title="Leave wallet?" dismissible={!busy}>
        <p>You will lose access to “{wallet.name}”. Your past transactions stay in the wallet. You would need a new invitation to rejoin.</p>
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => setLeaving(false)}>Cancel</Button>
          <Button variant="danger" disabled={busy} onClick={() => act(async () => { await service!.leave(wallet.id); setLeaving(false); onLeft() })}>Leave wallet</Button>
        </div>
      </Dialog>
    </>
  )
}
