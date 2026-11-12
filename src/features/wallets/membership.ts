import { syncCounts } from '../offline/syncLabels'
import type { MembershipErrorKind } from './membershipService'
import type { WalletRole } from './wallet'

/** Invitation links stay valid this long. Enforced by the database; shown to the user. */
export const INVITE_DAYS = 7

const TOKEN = /^[0-9a-f]{64}$/
const JOIN_PREFIX = '#/join/'

/** A CURRENT wallet member and the only profile fields co-members may see. Never an email. */
export interface Member {
  userId: string
  role: WalletRole
  joinedAt: string
  displayName: string | null
  avatarUrl: string | null
}

/** Shown for anyone who appears on a record but is not a current member of the wallet. Their profile is never exposed. */
export const FORMER_MEMBER = 'Former member'

/** A pending invitation as the owner may see it. The token itself is never retrievable after creation. */
export interface PendingInvitation {
  id: string
  createdAt: string
  expiresAt: string
}

/** Only ever held in memory, right after creation, so the owner can copy the link once. */
export interface CreatedInvitation {
  id: string
  token: string
  expiresAt: string
}

/** The token travels in the URL fragment: browsers never send it to the server, so it stays out of server logs. */
export const inviteLink = (origin: string, token: string): string => `${origin}/${JOIN_PREFIX}${token}`

/** Token from a `#/join/<token>` location hash, or null for anything else (including a malformed token). */
export function parseInviteHash(hash: string): string | null {
  if (!hash.startsWith(JOIN_PREFIX)) return null
  const token = hash.slice(JOIN_PREFIX.length)
  return TOKEN.test(token) ? token : null
}

/**
 * Label per CURRENT member: self is "You"; others use their display name; a member with no name is "Owner" or
 * "Member N" (numbered in join order). Only current members are in the map, so anyone else is a former member.
 */
export function memberLabels(members: readonly Member[], userId: string): Map<string, string> {
  const out = new Map<string, string>()
  let n = 0
  for (const m of [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))) {
    const fallback = m.role === 'owner' ? 'Owner' : `Member ${++n}`
    out.set(m.userId, m.userId === userId ? 'You' : m.displayName?.trim() || fallback)
  }
  return out
}

/**
 * Name to show for a user id found on a record (created_by / paid_by_user_id) in one wallet. `labels` is memberLabels of
 * the wallet's current members, or null when the member list could not be loaded (offline): then a non-self user is a
 * neutral "Another member", never a guess. Not in the list = no longer a member = "Former member", whatever the
 * profile table holds.
 */
export function participantLabel(id: string | null, userId: string, labels: ReadonlyMap<string, string> | null): string {
  if (id === userId) return 'You'
  if (id === null) return FORMER_MEMBER
  if (labels === null) return 'Another member'
  return labels.get(id) ?? FORMER_MEMBER
}

/** "1 member" / "3 members". */
export const memberCountLabel = (n: number) => `${n} ${n === 1 ? 'member' : 'members'}`

/** An avatar is shown only when the profile holds a real https URL; there is never a generated placeholder. */
export const validAvatarUrl = (url: string | null | undefined): string | null => (url && /^https:\/\/\S+$/.test(url) ? url : null)

/** What changes, and what does not, when ownership moves. Wording follows spec 6.4 and the transfer function. */
export const transferConsequences = (newOwner: string): string[] => [
  `${newOwner} becomes the Owner of this wallet.`,
  'You stay in the wallet as a Member. You can still view it and add transactions, but you can no longer invite or remove members, manage accounts, categories or budgets, rename the wallet or delete it.',
  'Past transactions, balances, accounts, budgets and categories are not changed.',
  'Invitation links that are still pending stay valid. The new Owner can revoke them.',
]

export const LEAVE_BLOCKED_MESSAGE = 'Sync or discard your pending transaction changes before leaving this wallet.'

/**
 * Leaves the wallet unless this device still holds live queued transactions for it. "Live" is the one definition the
 * other pages use (syncCounts.counted: PENDING, SYNCING and FAILED; never BLOCKED or CONFLICT), matched on the item's
 * wallet. Nothing is synced, discarded or changed here, and the leave call is not made when blocked. This sees only
 * this device's queue: it cannot protect against an owner removing someone whose queue is elsewhere.
 */
export async function attemptLeave(
  svc: { leave: (walletId: string) => Promise<void> },
  items: readonly { wallet_id: string; status: string }[],
  walletId: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (syncCounts(items, walletId).counted > 0) return { ok: false, message: LEAVE_BLOCKED_MESSAGE }
  await svc.leave(walletId)
  return { ok: true }
}

/** Why the last member-list load failed. The message is already safe to show. */
export interface MembersFailure {
  kind: MembershipErrorKind
  message: string
}

/** What the Members page knows about its list: the last good data, and whether the latest load failed. */
export interface MembersLoadState {
  members: Member[] | null
  invites: PendingInvitation[]
  failure: MembersFailure | null
}

export const MEMBERS_INITIAL: MembersLoadState = { members: null, invites: [], failure: null }

/** A load succeeded: new data, and any earlier failure is cleared. */
export const loadSucceeded = (members: Member[], invites: PendingInvitation[]): MembersLoadState => ({ members, invites, failure: null })

/** A load failed: remember why, and keep whatever was last loaded (never blank a good list because a refresh failed). */
export const loadFailed = (prev: MembersLoadState, failure: MembersFailure): MembersLoadState => ({ ...prev, failure })

export type MembersView = 'loading' | 'offline' | 'forbidden' | 'error' | 'list'

/**
 * Which screen the page shows. Any loaded list wins: a failed refresh is a warning on the list, not a replacement for it.
 * Only with no list at all does a failure (or being offline) take over the page.
 */
export function membersView(s: MembersLoadState, online: boolean): MembersView {
  if (s.members) return 'list'
  if (!online || s.failure?.kind === 'network') return 'offline'
  if (s.failure) return s.failure.kind === 'forbidden' ? 'forbidden' : 'error'
  return 'loading'
}

/**
 * The non-blocking notice shown above a list that is already loaded when the latest refresh failed, or null.
 * It says nothing about any membership action: a refresh failing never means an earlier remove/revoke/transfer failed.
 */
export function refreshWarning(s: MembersLoadState): string | null {
  if (!s.members || !s.failure) return null
  const stale = 'The information shown may be outdated.'
  if (s.failure.kind === 'network') return `Couldn't refresh members because you're offline. ${stale}`
  if (s.failure.kind === 'forbidden') return `Couldn't refresh members. You may no longer have access to this wallet. ${stale}`
  return `Couldn't refresh members. ${stale}`
}
