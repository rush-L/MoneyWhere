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
