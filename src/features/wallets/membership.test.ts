import { describe, expect, it, vi } from 'vitest'
import { FORMER_MEMBER, inviteLink, memberLabels, parseInviteHash, participantLabel, type Member } from './membership'
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

const m = (userId: string, role: 'owner' | 'member', joinedAt: string, displayName: string | null = null): Member =>
  ({ userId, role, joinedAt, displayName, avatarUrl: null })

describe('memberLabels (current members only)', () => {
  const members = [m('o', 'owner', '2026-01-01', 'Olivia'), m('b', 'member', '2026-02-01', 'Ben'), m('a', 'member', '2026-01-15', 'Ana')]
  it('self is "You"; everyone else uses their display name, so not every member is "You"', () => {
    expect(Object.fromEntries(memberLabels(members, 'b'))).toEqual({ o: 'Olivia', a: 'Ana', b: 'You' })
    expect(Object.fromEntries(memberLabels(members, 'o'))).toEqual({ o: 'You', a: 'Ana', b: 'Ben' })
  })
  it('a member without a display name falls back to Owner / Member N (join order); blank names count as none', () => {
    const nameless = [m('o', 'owner', '2026-01-01'), m('b', 'member', '2026-02-01', '   '), m('a', 'member', '2026-01-15')]
    expect(Object.fromEntries(memberLabels(nameless, 'x'))).toEqual({ o: 'Owner', a: 'Member 1', b: 'Member 2' })
  })
})

describe('participantLabel (created_by / paid_by_user_id on a record)', () => {
  const current = [m('o', 'owner', '2026-01-01', 'Olivia'), m('b', 'member', '2026-02-01', 'Ben')]
  it('current user is "You"; a current member shows their current identity; the owner stays the owner', () => {
    const labels = memberLabels(current, 'b')
    expect(participantLabel('b', 'b', labels)).toBe('You')
    expect(participantLabel('o', 'b', labels)).toBe('Olivia')
    expect(participantLabel('b', 'o', memberLabels(current, 'o'))).toBe('Ben')
  })
  it('before / after: the same record resolves to a name, then to "Former member" once the person is no longer a member', () => {
    const before = memberLabels(current, 'o')
    expect(participantLabel('b', 'o', before)).toBe('Ben')
    const after = memberLabels(current.filter((x) => x.userId !== 'b'), 'o') // Ben left or was removed
    expect(participantLabel('b', 'o', after)).toBe(FORMER_MEMBER)
    expect(participantLabel('b', 'o', after)).toBe('Former member')
    expect(JSON.stringify([...after])).not.toContain('Ben') // the old name is not in anything the UI holds
  })
  it('an unknown historical user (never listed) and a null id are "Former member", never a profile', () => {
    const labels = memberLabels(current, 'o')
    expect(participantLabel('someone-else', 'o', labels)).toBe(FORMER_MEMBER)
    expect(participantLabel(null, 'o', labels)).toBe(FORMER_MEMBER)
  })
  it('when the member list could not be loaded (offline) other people are a neutral "Another member", not "Former member"', () => {
    expect(participantLabel('b', 'o', null)).toBe('Another member')
    expect(participantLabel('o', 'o', null)).toBe('You')
  })
  it('former-member label is exact', () => expect(FORMER_MEMBER).toBe('Former member'))
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
  it('listMembers maps the visibility function reply (name and avatar only) and asks for the wallet', async () => {
    const { svc, rpc } = client({ data: [{ user_id: 'u1', role: 'owner', joined_at: '2026-01-01T00:00:00Z', display_name: 'Olivia', avatar_url: 'https://img.example/o.png' }] })
    await expect(svc.listMembers('w1')).resolves.toEqual([{ userId: 'u1', role: 'owner', joinedAt: '2026-01-01T00:00:00Z', displayName: 'Olivia', avatarUrl: 'https://img.example/o.png' }])
    expect(rpc).toHaveBeenCalledWith('list_wallet_members', { p_wallet_id: 'w1' })
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
    await ok.svc.transferOwnership('w1', 'u2')
    expect(ok.rpc.mock.calls).toEqual([
      ['leave_wallet', { p_wallet_id: 'w1' }],
      ['remove_wallet_member', { p_wallet_id: 'w1', p_user_id: 'u1' }],
      ['revoke_wallet_invitation', { p_invitation_id: 'i1' }],
      ['transfer_wallet_ownership', { p_wallet_id: 'w1', p_new_owner: 'u2' }],
    ])
  })
  it('transferOwnership maps failures to safe messages and never pretends to succeed (network error rejects)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(client({ error: { code: '42501' } }).svc.transferOwnership('w', 'u')).rejects.toThrow('Only the wallet owner can transfer ownership.')
    await expect(client({ error: { code: 'P0002' } }).svc.transferOwnership('w', 'u')).rejects.toThrow('That person is no longer a member of this wallet.')
    await expect(client({ error: { message: 'TypeError: Failed to fetch' } }).svc.transferOwnership('w', 'u')).rejects.toThrow('Could not transfer ownership. Please try again.')
  })
})
