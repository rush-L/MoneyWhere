import type { WalletRole } from './wallet'

/** Invitation links stay valid this long. Enforced by the database; shown to the user. */
export const INVITE_DAYS = 7

const TOKEN = /^[0-9a-f]{64}$/
const JOIN_PREFIX = '#/join/'

export interface Member {
  userId: string
  role: WalletRole
  joinedAt: string
}

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

/** Self is "You"; the owner is "Owner"; other members are numbered in join order (names arrive with co-member visibility). */
export function memberLabels(members: readonly Member[], userId: string): Map<string, string> {
  const out = new Map<string, string>()
  let n = 0
  for (const m of [...members].sort((a, b) => a.joinedAt.localeCompare(b.joinedAt))) {
    out.set(m.userId, m.userId === userId ? 'You' : m.role === 'owner' ? 'Owner' : `Member ${++n}`)
  }
  return out
}
