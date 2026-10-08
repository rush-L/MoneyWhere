import { describe, expect, it, vi } from 'vitest'
import { inviteLink, memberLabels, parseInviteHash, type Member } from './membership'
import { createMembershipService, MembershipError } from './membershipService'

const TOKEN = 'ab12'.repeat(16) // 64 hex chars (a test value, not a real secret)

describe('invitation link', () => {
  it('puts the token in the URL fragment, so it is never sent to a server', () => {
    const link = inviteLink('https://app.example', TOKEN)
    expect(link).toBe(`https://app.example/#/join/${TOKEN}`)
    expect(new URL(link).search).toBe('')
    expect(new URL(link).pathname).toBe('/')
  })
  it('parses a valid join hash back to the token', () => {
    expect(parseInviteHash(`#/join/${TOKEN}`)).toBe(TOKEN)
  })
  it.each([
    ['empty', ''],
    ['other route', '#/wallets'],
    ['auth callback', '#access_token=x&type=recovery'],
    ['short token', '#/join/abc'],
    ['uppercase', `#/join/${TOKEN.toUpperCase()}`],
    ['non-hex', `#/join/${'z'.repeat(64)}`],
    ['trailing junk', `#/join/${TOKEN}/extra`],
    ['no token', '#/join/'],
  ])('rejects %s', (_n, hash) => expect(parseInviteHash(hash)).toBeNull())
})

describe('memberLabels', () => {
  const m = (userId: string, role: 'owner' | 'member', joinedAt: string): Member => ({ userId, role, joinedAt })
  const members = [m('o', 'owner', '2026-01-01'), m('b', 'member', '2026-02-01'), m('a', 'member', '2026-01-15')]
  it('labels self "You", the owner "Owner", others by join order, and exposes no ids', () => {
    expect(Object.fromEntries(memberLabels(members, 'b'))).toEqual({ o: 'Owner', a: 'Member 1', b: 'You' })
    expect(Object.fromEntries(memberLabels(members, 'o'))).toEqual({ o: 'You', a: 'Member 1', b: 'Member 2' })
  })
})

type Reply = { data?: unknown; error?: { code?: string; message?: string } | null }
const client = (reply: Reply) => {
  const rpc = vi.fn(async () => ({ data: null, error: null, ...reply }))
  return { rpc, svc: createMembershipService({ rpc } as never) }
}

describe('membership service', () => {
  it('createInvitation maps the RPC reply and returns the token to the caller only', async () => {
    const { svc, rpc } = client({ data: { id: 'i1', token: TOKEN, expires_at: '2026-10-15T00:00:00Z' } })
    await expect(svc.createInvitation('w1')).resolves.toEqual({ id: 'i1', token: TOKEN, expiresAt: '2026-10-15T00:00:00Z' })
    expect(rpc).toHaveBeenCalledWith('create_wallet_invitation', { p_wallet_id: 'w1' })
  })
  it('preview and accept map valid and generic-invalid replies', async () => {
    await expect(client({ data: { ok: true, wallet_name: 'Home', already_member: false } }).svc.previewInvitation(TOKEN)).resolves.toEqual({ valid: true, walletName: 'Home', alreadyMember: false })
    await expect(client({ data: { ok: false } }).svc.previewInvitation(TOKEN)).resolves.toEqual({ valid: false })
    await expect(client({ data: { ok: true, wallet_id: 'w', joined: true } }).svc.acceptInvitation(TOKEN)).resolves.toEqual({ ok: true, joined: true })
    await expect(client({ data: { ok: false } }).svc.acceptInvitation(TOKEN)).resolves.toEqual({ ok: false })
  })
  it('a rate-limit error becomes a friendly message', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { svc } = client({ error: { code: '54000', message: 'rate limit exceeded' } })
    await expect(svc.acceptInvitation(TOKEN)).rejects.toThrow('Too many attempts. Please wait a while and try again.')
    await expect(svc.createInvitation('w')).rejects.toBeInstanceOf(MembershipError)
  })
  it('errors carry a safe message and the token never reaches the console', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { svc } = client({ error: { code: 'XX000', message: 'internal detail' } })
    await expect(svc.acceptInvitation(TOKEN)).rejects.toThrow('Could not accept the invitation. Please try again.')
    await expect(svc.previewInvitation(TOKEN)).rejects.toThrow('Could not check the invitation. Please try again.')
    expect(JSON.stringify(spy.mock.calls)).not.toContain(TOKEN)
  })
  it('owner-only failures explain themselves; leave, remove and revoke use the RPCs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(client({ error: { code: '42501' } }).svc.createInvitation('w')).rejects.toThrow('Only the wallet owner can invite members.')
    await expect(client({ error: { code: '42501' } }).svc.leave('w')).rejects.toThrow('The owner cannot leave a wallet.')
    const ok = client({})
    await ok.svc.leave('w1')
    await ok.svc.removeMember('w1', 'u1')
    await ok.svc.revokeInvitation('i1')
    expect(ok.rpc.mock.calls).toEqual([
      ['leave_wallet', { p_wallet_id: 'w1' }],
      ['remove_wallet_member', { p_wallet_id: 'w1', p_user_id: 'u1' }],
      ['revoke_wallet_invitation', { p_invitation_id: 'i1' }],
    ])
  })
})
