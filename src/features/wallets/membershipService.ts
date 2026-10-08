import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreatedInvitation, Member, PendingInvitation } from './membership'
import type { WalletRole } from './wallet'

/** Message is always safe to show to the user. */
export class MembershipError extends Error {}

type Err = { code?: string; message?: string }
const RATE_LIMITED = '54000' // raised by the database rate limiter

/** Logs the error code and message only: never request parameters, which can hold an invitation token. */
function fail(message: string, err: Err): never {
  console.error('[membership]', err.code, err.message)
  throw new MembershipError(err.code === RATE_LIMITED ? 'Too many attempts. Please wait a while and try again.' : message)
}

export type InvitationPreview = { valid: false } | { valid: true; walletName: string; alreadyMember: boolean }
export type AcceptResult = { ok: false } | { ok: true; joined: boolean }

/** Membership writes are online-only (no outbox): a network failure surfaces as the same safe message. */
export function createMembershipService(client: SupabaseClient) {
  return {
    /**
     * Current members with display name and avatar, for members of that wallet only (database function; profiles are
     * not readable directly). Former members are not returned.
     */
    async listMembers(walletId: string): Promise<Member[]> {
      const { data, error } = await client.rpc('list_wallet_members', { p_wallet_id: walletId })
      if (error) fail('Could not load members. Please try again.', error)
      return (data as { user_id: string; role: string; joined_at: string; display_name: string | null; avatar_url: string | null }[]).map((r) => ({
        userId: r.user_id,
        role: (r.role === 'owner' ? 'owner' : 'member') as WalletRole,
        joinedAt: r.joined_at,
        displayName: r.display_name,
        avatarUrl: r.avatar_url,
      }))
    },
    /** Owner only (RLS returns nothing to anyone else). Token hashes are not readable columns. */
    async listInvitations(walletId: string): Promise<PendingInvitation[]> {
      const { data, error } = await client
        .from('wallet_invitations')
        .select('id, created_at, expires_at')
        .eq('wallet_id', walletId)
        .is('revoked_at', null)
        .is('accepted_at', null)
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false })
        .returns<{ id: string; created_at: string; expires_at: string }[]>()
      if (error) fail('Could not load invitations. Please try again.', error)
      return data.map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at }))
    },
    async createInvitation(walletId: string): Promise<CreatedInvitation> {
      const { data, error } = await client.rpc('create_wallet_invitation', { p_wallet_id: walletId })
      if (error) fail(error.code === '42501' ? 'Only the wallet owner can invite members.' : 'Could not create the invitation. Please try again.', error)
      const d = data as { id: string; token: string; expires_at: string }
      return { id: d.id, token: d.token, expiresAt: d.expires_at }
    },
    async revokeInvitation(invitationId: string): Promise<void> {
      const { error } = await client.rpc('revoke_wallet_invitation', { p_invitation_id: invitationId })
      if (error) fail('Could not revoke the invitation. It may already be used or revoked.', error)
    },
    async removeMember(walletId: string, userId: string): Promise<void> {
      const { error } = await client.rpc('remove_wallet_member', { p_wallet_id: walletId, p_user_id: userId })
      if (error) fail('Could not remove the member. Please try again.', error)
    },
    /** Owner only; the new owner must be a current member. One atomic RPC: there is no client-side role editing and no offline path. */
    async transferOwnership(walletId: string, newOwnerId: string): Promise<void> {
      const { error } = await client.rpc('transfer_wallet_ownership', { p_wallet_id: walletId, p_new_owner: newOwnerId })
      if (error) {
        fail(
          error.code === '42501' ? 'Only the wallet owner can transfer ownership.'
          : error.code === 'P0002' ? 'That person is no longer a member of this wallet.'
          : 'Could not transfer ownership. Please try again.',
          error,
        )
      }
    },
    async leave(walletId: string): Promise<void> {
      const { error } = await client.rpc('leave_wallet', { p_wallet_id: walletId })
      if (error) fail(error.code === '42501' ? 'The owner cannot leave a wallet.' : 'Could not leave the wallet. Please try again.', error)
    },
    async previewInvitation(token: string): Promise<InvitationPreview> {
      const { data, error } = await client.rpc('preview_wallet_invitation', { p_token: token })
      if (error) fail('Could not check the invitation. Please try again.', error)
      const d = data as { ok: boolean; wallet_name?: string; already_member?: boolean }
      return d.ok ? { valid: true, walletName: d.wallet_name ?? 'this wallet', alreadyMember: !!d.already_member } : { valid: false }
    },
    async acceptInvitation(token: string): Promise<AcceptResult> {
      const { data, error } = await client.rpc('accept_wallet_invitation', { p_token: token })
      if (error) fail('Could not accept the invitation. Please try again.', error)
      const d = data as { ok: boolean; joined?: boolean }
      return d.ok ? { ok: true, joined: !!d.joined } : { ok: false }
    },
  }
}

export type MembershipService = ReturnType<typeof createMembershipService>
