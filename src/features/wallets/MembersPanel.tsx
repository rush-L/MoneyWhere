import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../../lib/supabase'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Dialog } from '../../ui/Dialog'
import { formatDate } from '../../ui/formatDate'
import { PageHeader } from '../../ui/PageHeader'
import { Section } from '../../ui/Section'
import { State } from '../../ui/State'
import { useOffline } from '../offline/hooks/OfflineProvider'
import { syncCounts } from '../offline/syncLabels'
import {
  attemptLeave, INVITE_DAYS, inviteLink, LEAVE_BLOCKED_MESSAGE, loadFailed, loadSucceeded, MEMBERS_INITIAL, memberCountLabel, memberLabels, membersView, refreshWarning, transferConsequences, validAvatarUrl,
  type CreatedInvitation,
} from './membership'
import { createMembershipService, MembershipError } from './membershipService'
import type { Wallet } from './wallet'

const OFFLINE = "Members aren't available offline. Connect to the internet to view or manage wallet membership."
const FORBIDDEN = "You don't have access to this wallet's members."

/**
 * Members and invitations for one wallet. Online only: membership changes are never queued offline, and nothing here is cached.
 * Authorization is the database's; the owner-only controls here just mirror it.
 */
export function MembersPanel({ wallet, userId, onLeft, onTransferred }: { wallet: Wallet; userId: string; onLeft: () => void; onTransferred: () => void }) {
  const service = useMemo(() => (supabase ? createMembershipService(supabase) : null), [])
  const { online, items } = useOffline()
  const itemsRef = useRef(items) // the latest queue, read when Leave is confirmed
  useEffect(() => {
    itemsRef.current = items
  }, [items])
  const isOwner = wallet.role === 'owner'
  const [data, setData] = useState(MEMBERS_INITIAL) // last good list + whether the latest load failed
  const { members, invites } = data
  const [retrying, setRetrying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null) // success feedback, set only after the backend confirmed
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<CreatedInvitation | null>(null) // in memory only; the link is shown once
  const [copied, setCopied] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const [leaveError, setLeaveError] = useState<string | null>(null)
  const [transferTo, setTransferTo] = useState<string | null>(null) // chosen target
  const [confirmTransfer, setConfirmTransfer] = useState(false)
  const inviteCard = useRef<HTMLDivElement>(null)

  const load = useCallback(() => {
    if (!service) return Promise.resolve()
    return Promise.all([service.listMembers(wallet.id), isOwner ? service.listInvitations(wallet.id) : Promise.resolve([])]).then(
      ([m, i]) => setData(loadSucceeded(m, i)),
      (e: unknown) => setData((prev) => loadFailed(prev, { kind: e instanceof MembershipError ? e.kind : 'other', message: e instanceof Error ? e.message : 'Could not load members. Please try again.' })),
    )
  }, [service, wallet.id, isOwner])
  useEffect(() => {
    if (online) void load() // offline there is nothing to ask: the offline state below says so at once
  }, [load, online])

  useEffect(() => {
    if (created) inviteCard.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }) // the link appears in the Invitations card
  }, [created])

  async function act(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const createInvite = () =>
    act(async () => {
      setCreated(await service!.createInvitation(wallet.id))
      setCopied(false)
      await load()
    })

  const retry = async () => {
    setRetrying(true)
    await load()
    setRetrying(false)
  }

  const link = created ? inviteLink(window.location.origin, created.token) : ''
  const labels = members ? memberLabels(members, userId) : new Map<string, string>()
  const others = (members ?? []).filter((m) => m.role === 'member')
  const liveQueued = syncCounts(items, wallet.id).counted > 0 // shown in the Leave dialog; the click re-reads itemsRef

  const header = <PageHeader title="Members" level={2} actions={members && isOwner ? <Button className="add-desktop" disabled={busy} onClick={() => void createInvite()}>Create invite link</Button> : undefined} />

  const view = membersView(data, online)
  if (view === 'offline') return <>{header}<State kind="empty" action={<Button onClick={() => void load()}>Retry</Button>}>{OFFLINE}</State></>
  if (view === 'forbidden') return <>{header}<State kind="error" action={<Button onClick={() => void load()}>Retry</Button>}>{FORBIDDEN}</State></>
  if (view === 'error') return <>{header}<State kind="error" action={<Button onClick={() => void load()}>Retry</Button>}>{data.failure?.message}</State></>
  if (view === 'loading' || !members) return <>{header}<State kind="loading">Loading members…</State></>
  const warning = refreshWarning(data) // a failed refresh of an already-loaded list

  return (
    <div className="members-page">
      {header}
      {isOwner && <button type="button" className="fab" aria-label="Create invite link" disabled={busy} onClick={() => void createInvite()}>+</button>}
      <p className="count-line">{memberCountLabel(members.length)}</p>
      <p className="group-note">Everyone here can view this wallet and add transactions. Only the Owner can invite, remove members or transfer ownership. Membership changes need an internet connection.</p>
      {warning && (
        <div role="status" className="note refresh-warning">
          <span>{warning}</span>
          <Button variant="secondary" disabled={retrying} onClick={() => void retry()}>{retrying ? 'Retrying…' : 'Retry'}</Button>
        </div>
      )}
      {!online && !warning && <p role="status" className="note">You're offline. Membership changes won't work until you reconnect.</p>}
      {notice && <p role="status" className="note good">{notice}</p>}
      {error && <p role="alert" className="error">{error}</p>}

      <div className="card">
        <Section title="People">
          <ul className="member-list">
            {members.map((m) => {
              const avatar = validAvatarUrl(m.avatarUrl)
              return (
                <li key={m.userId} className="member-row">
                  <div className="member-main">
                    <strong className="member-name">
                      {avatar && <img className="member-avatar" src={avatar} alt="" referrerPolicy="no-referrer" onError={(e) => { e.currentTarget.style.display = 'none' }} />}
                      {labels.get(m.userId)}
                    </strong>
                    <span className="member-meta">
                      <Badge tone={m.role === 'owner' ? 'info' : 'neutral'}>{m.role === 'owner' ? 'Owner' : 'Member'}</Badge>
                      <small>Joined {formatDate(m.joinedAt)}</small>
                    </span>
                  </div>
                  {isOwner && m.role === 'member' && (
                    <Button variant="ghost" className="text-danger" disabled={busy} onClick={() => { setNotice(null); setRemoving(m.userId) }} aria-label={`Remove ${labels.get(m.userId)}`}>Remove</Button>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      </div>

      {isOwner && (
        <div className="card" ref={inviteCard}>
          <Section title="Invitations">
            <p className="group-note">Create a link and share it with the person you want to invite. Each link works once and expires in {INVITE_DAYS} days.</p>
            {created && (
              <div role="status" className="invite-box">
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
            <h3 className="group-head">Pending invitations <small>· {invites.length}</small></h3>
            {invites.length === 0 ? (
              <State kind="empty">No pending invitations</State>
            ) : (
              <ul className="invite-list">
                {invites.map((i) => (
                  <li key={i.id} className="invite-row">
                    <div className="member-main">
                      <strong>Invite link</strong>
                      <small>Created {formatDate(i.createdAt)} · Expires {formatDate(i.expiresAt)}</small>
                    </div>
                    <Button
                      variant="ghost"
                      className="text-danger"
                      disabled={busy}
                      aria-label={`Revoke the invite link created ${formatDate(i.createdAt)}`}
                      onClick={() => act(async () => {
                        await service!.revokeInvitation(i.id)
                        if (created?.id === i.id) setCreated(null)
                        setNotice('Invitation link revoked.')
                        await load()
                      })}
                    >
                      Revoke
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      )}

      {isOwner && (
        <div className="card">
          <Section title="Transfer ownership">
            {others.length > 0 ? (
              <>
                <p className="group-note">Make another current member the Owner. You stay in the wallet as a Member.</p>
                <select aria-label="New owner" value={transferTo ?? ''} disabled={busy} onChange={(e) => setTransferTo(e.target.value || null)}>
                  <option value="">Choose a member…</option>
                  {others.map((m) => <option key={m.userId} value={m.userId}>{labels.get(m.userId)}</option>)}
                </select>
                <Button variant="secondary" disabled={busy || !transferTo} onClick={() => { setNotice(null); setConfirmTransfer(true) }}>Transfer ownership</Button>
              </>
            ) : (
              <State kind="empty">Invite someone first. Ownership can only be transferred to an existing member.</State>
            )}
          </Section>
        </div>
      )}

      {!isOwner && (
        <div className="card">
          <Section title="Leave this wallet">
            <p className="group-note">You can leave at any time. Your past transactions stay in the wallet, and you would need a new invitation to rejoin.</p>
            <div className="actions">
              <Button variant="secondary" className="text-danger" disabled={busy} onClick={() => { setNotice(null); setLeaveError(null); setLeaving(true) }}>Leave wallet</Button>
            </div>
          </Section>
        </div>
      )}

      <Dialog open={removing !== null} onClose={() => setRemoving(null)} title="Remove member?" dismissible={!busy}>
        <p>{removing ? labels.get(removing) : ''} will lose access to this wallet immediately. Their past transactions stay in the wallet. Transactions they recorded but haven't synced yet may not be saved.</p>
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => setRemoving(null)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => act(async () => {
              const name = labels.get(removing!)
              await service!.removeMember(wallet.id, removing!)
              setRemoving(null)
              setNotice(`${name} was removed from this wallet.`)
              await load()
            })}
          >
            Remove member
          </Button>
        </div>
      </Dialog>
      <Dialog open={confirmTransfer && transferTo !== null} onClose={() => setConfirmTransfer(false)} title={`Transfer ownership to ${transferTo ? labels.get(transferTo) : ''}?`} dismissible={!busy}>
        <ul className="consequences">
          {transferTo && transferConsequences(labels.get(transferTo) ?? 'This member').map((line) => <li key={line}>{line}</li>)}
        </ul>
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => setConfirmTransfer(false)}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => act(async () => {
              const name = labels.get(transferTo!)
              await service!.transferOwnership(wallet.id, transferTo!)
              setConfirmTransfer(false)
              setTransferTo(null)
              setNotice(`Ownership transferred to ${name}. You are now a Member.`)
              onTransferred()
            })}
          >
            Transfer ownership
          </Button>
        </div>
      </Dialog>
      <Dialog open={leaving} onClose={() => { setLeaving(false); setLeaveError(null) }} title="Leave wallet?" dismissible={!busy}>
        <p>You will lose access to “{wallet.name}”. Your past transactions stay in the wallet. You would need a new invitation to rejoin.</p>
        {(leaveError || liveQueued) && <p role="alert" className="error">{leaveError ?? LEAVE_BLOCKED_MESSAGE}</p>}
        <div className="actions">
          <Button variant="secondary" disabled={busy} onClick={() => { setLeaving(false); setLeaveError(null) }}>Cancel</Button>
          <Button
            variant="danger"
            disabled={busy || liveQueued}
            onClick={() => act(async () => {
              // The queue is re-read now (not as it was when the dialog opened); the leave call is skipped if anything is live.
              const result = await attemptLeave(service!, itemsRef.current, wallet.id)
              if (!result.ok) return setLeaveError(result.message)
              setLeaving(false)
              onLeft()
            })}
          >
            Leave wallet
          </Button>
        </div>
      </Dialog>
    </div>
  )
}
