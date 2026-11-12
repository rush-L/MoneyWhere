import { describe, expect, it, vi } from 'vitest'
import { attemptLeave, FORMER_MEMBER, inviteLink, LEAVE_BLOCKED_MESSAGE, loadFailed, loadSucceeded, MEMBERS_INITIAL, memberCountLabel, memberLabels, membersView, parseInviteHash, participantLabel, refreshWarning, transferConsequences, validAvatarUrl, type Member, type MembersFailure } from './membership'
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

describe('member count and avatars', () => {
  it('counts', () => {
    expect(memberCountLabel(1)).toBe('1 member')
    expect(memberCountLabel(3)).toBe('3 members')
    expect(memberCountLabel(0)).toBe('0 members')
  })
  it('an avatar is shown only for a real https URL, never generated', () => {
    expect(validAvatarUrl('https://example.test/a.png')).toBe('https://example.test/a.png')
    for (const bad of [null, undefined, '', '   ', 'http://example.test/a.png', 'javascript:alert(1)', 'data:image/png;base64,AAAA', 'https://', 'not a url', 'https://a.test/has space.png']) {
      expect(validAvatarUrl(bad as string | null | undefined)).toBeNull()
    }
  })
})

describe('ownership transfer consequences', () => {
  const lines = transferConsequences('Bella')
  it('names the new owner and says the current owner stays as a member', () => {
    expect(lines[0]).toBe('Bella becomes the Owner of this wallet.')
    expect(lines[1]).toMatch(/stay in the wallet as a Member/)
    expect(lines[1]).toMatch(/no longer invite or remove members, manage accounts, categories or budgets, rename the wallet or delete it/)
  })
  it('says history and financial data are unchanged, and that pending invitations stay valid', () => {
    expect(lines[2]).toBe('Past transactions, balances, accounts, budgets and categories are not changed.')
    expect(lines[3]).toBe('Invitation links that are still pending stay valid. The new Owner can revoke them.')
  })
  it('never claims the transfer invalidates invitations or touches money', () => {
    expect(lines.join(' ')).not.toMatch(/invalidat|cancel|expire|revoked automatically/i)
  })
})

describe('attemptLeave (the voluntary-leave guard)', () => {
  const item = (wallet_id: string, status: string) => ({ wallet_id, status })
  const svc = () => ({ leave: vi.fn(async () => undefined) })

  it('an empty queue lets the member leave, and calls the leave RPC once with the wallet', async () => {
    const s = svc()
    await expect(attemptLeave(s, [], 'w1')).resolves.toEqual({ ok: true })
    expect(s.leave).toHaveBeenCalledTimes(1)
    expect(s.leave).toHaveBeenCalledWith('w1')
  })
  it('a live queued item for this wallet blocks leaving and the RPC is never called', async () => {
    const s = svc()
    await expect(attemptLeave(s, [item('w1', 'PENDING')], 'w1')).resolves.toEqual({ ok: false, message: LEAVE_BLOCKED_MESSAGE })
    expect(s.leave).not.toHaveBeenCalled()
  })
  it('PENDING, SYNCING and FAILED are live', async () => {
    for (const status of ['PENDING', 'SYNCING', 'FAILED']) {
      const s = svc()
      expect((await attemptLeave(s, [item('w1', status)], 'w1')).ok).toBe(false)
      expect(s.leave).not.toHaveBeenCalled()
    }
  })
  it('BLOCKED and CONFLICT do not block leaving', async () => {
    for (const status of ['BLOCKED', 'CONFLICT']) {
      const s = svc()
      expect((await attemptLeave(s, [item('w1', status)], 'w1')).ok).toBe(true)
      expect(s.leave).toHaveBeenCalledTimes(1)
    }
  })
  it('items of another wallet do not block leaving', async () => {
    const s = svc()
    expect((await attemptLeave(s, [item('w2', 'PENDING'), item('w3', 'FAILED')], 'w1')).ok).toBe(true)
    expect(s.leave).toHaveBeenCalledWith('w1')
  })
  it('one live item among dead and foreign ones is enough to block', async () => {
    const s = svc()
    const queue = [item('w1', 'BLOCKED'), item('w2', 'PENDING'), item('w1', 'CONFLICT'), item('w1', 'SYNCING')]
    expect((await attemptLeave(s, queue, 'w1')).ok).toBe(false)
    expect(s.leave).not.toHaveBeenCalled()
  })
  it('judges the queue it is given at the moment of the call: an item queued after the dialog opened is caught', async () => {
    const s = svc()
    const whenDialogOpened: { wallet_id: string; status: string }[] = []
    expect(whenDialogOpened.filter((i) => i.status !== 'BLOCKED').length).toBe(0) // nothing live yet, so the dialog would allow it
    const atConfirm = [...whenDialogOpened, item('w1', 'PENDING')] // queued while the dialog was open
    await expect(attemptLeave(s, atConfirm, 'w1')).resolves.toEqual({ ok: false, message: LEAVE_BLOCKED_MESSAGE })
    expect(s.leave).not.toHaveBeenCalled()
  })
  it('a failing leave call is not swallowed', async () => {
    const s = { leave: vi.fn(async () => { throw new MembershipError('The owner cannot leave a wallet.') }) }
    await expect(attemptLeave(s, [], 'w1')).rejects.toThrow('The owner cannot leave a wallet.')
  })
  it('says exactly what to do', () => {
    expect(LEAVE_BLOCKED_MESSAGE).toBe('Sync or discard your pending transaction changes before leaving this wallet.')
  })
})

describe('membership errors say why they failed', () => {
  it('a network failure is "network"; permission failures are "forbidden"; anything else is "other"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const kind = async (error: object) => {
      try {
        await client({ error }).svc.listMembers('w')
      } catch (e) {
        return (e as MembershipError).kind
      }
    }
    expect(await kind({ message: 'TypeError: Failed to fetch' })).toBe('network')
    expect(await kind({ message: 'Load failed' })).toBe('network')
    expect(await kind({ code: '42501', message: 'not allowed' })).toBe('forbidden')
    expect(await kind({ code: 'XX000', message: 'internal' })).toBe('other')
    expect(await kind({ code: '54000', message: 'rate limit exceeded' })).toBe('other')
  })
  it('messages are unchanged by classification', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(client({ error: { message: 'TypeError: Failed to fetch' } }).svc.listMembers('w')).rejects.toThrow('Could not load members. Please try again.')
    await expect(client({ error: { code: '42501' } }).svc.listMembers('w')).rejects.toThrow('Could not load members. Please try again.')
  })
})

describe('members load state: a failed refresh never replaces a loaded list', () => {
  const m = (userId: string, role: 'owner' | 'member' = 'member'): Member => ({ userId, role, joinedAt: '2026-01-01T00:00:00Z', displayName: userId, avatarUrl: null })
  const loaded = loadSucceeded([m('a', 'owner'), m('b')], [{ id: 'i1', createdAt: '2026-11-01T00:00:00Z', expiresAt: '2026-11-08T00:00:00Z' }])
  const fail = (kind: MembersFailure['kind'], message = 'Could not load members. Please try again.'): MembersFailure => ({ kind, message })

  // 1. initial load failure, no list: the existing full-page states are unchanged
  it('an initial failure with no list still takes over the page, in the existing three flavours', () => {
    expect(membersView(MEMBERS_INITIAL, true)).toBe('loading')
    expect(membersView(loadFailed(MEMBERS_INITIAL, fail('other')), true)).toBe('error')
    expect(membersView(loadFailed(MEMBERS_INITIAL, fail('forbidden')), true)).toBe('forbidden')
    expect(membersView(loadFailed(MEMBERS_INITIAL, fail('network')), true)).toBe('offline')
    expect(membersView(MEMBERS_INITIAL, false)).toBe('offline') // no request is even attempted while offline
  })
  it('an initial failure shows no refresh warning (there is nothing stale to warn about)', () => {
    for (const kind of ['network', 'forbidden', 'other'] as const) expect(refreshWarning(loadFailed(MEMBERS_INITIAL, fail(kind)))).toBeNull()
  })

  // 2. refresh failure after a good load: the list stays
  it('a refresh failure keeps the loaded members and invitations, and the page stays on the list', () => {
    const s = loadFailed(loaded, fail('other'))
    expect(s.members).toBe(loaded.members)
    expect(s.invites).toBe(loaded.invites)
    for (const kind of ['network', 'forbidden', 'other'] as const) expect(membersView(loadFailed(loaded, fail(kind)), true)).toBe('list')
    expect(membersView(loadFailed(loaded, fail('other')), false)).toBe('list') // even if the connection has since dropped
  })

  // 3. the warning
  it('a refresh failure produces the warning; the generic one is the approved copy', () => {
    expect(refreshWarning(loadFailed(loaded, fail('other')))).toBe("Couldn't refresh members. The information shown may be outdated.")
  })
  it('offline and forbidden refresh failures keep their own distinct wording, each still saying the data may be outdated', () => {
    const offline = refreshWarning(loadFailed(loaded, fail('network')))!
    const forbidden = refreshWarning(loadFailed(loaded, fail('forbidden')))!
    const other = refreshWarning(loadFailed(loaded, fail('other')))!
    expect(new Set([offline, forbidden, other]).size).toBe(3)
    expect(offline).toMatch(/offline/)
    expect(forbidden).toMatch(/no longer have access/)
    for (const w of [offline, forbidden, other]) expect(w).toMatch(/The information shown may be outdated\.$/)
  })
  it('there is no warning while the list is healthy', () => expect(refreshWarning(loaded)).toBeNull())

  // 4. retry
  it('a successful retry clears the warning and replaces the data', () => {
    const failed = loadFailed(loaded, fail('network'))
    expect(refreshWarning(failed)).not.toBeNull()
    const fresh = loadSucceeded([m('a', 'owner')], [])
    const after = fresh // what the page does when the retry resolves
    expect(after.failure).toBeNull()
    expect(refreshWarning(after)).toBeNull()
    expect(after.members).toHaveLength(1)
    expect(membersView(after, true)).toBe('list')
  })
  it('a retry that fails again keeps the same list and the warning', () => {
    const again = loadFailed(loadFailed(loaded, fail('other')), fail('other'))
    expect(again.members).toBe(loaded.members)
    expect(refreshWarning(again)).not.toBeNull()
  })

  // 5. an action followed by a failed refresh
  it('a failed refresh after a successful action never says or implies the action failed', () => {
    // The action's own success notice lives outside this state; a failed refresh only sets `failure`.
    const afterAction = loadFailed(loaded, fail('other'))
    expect(Object.keys(afterAction).sort()).toEqual(['failure', 'invites', 'members'])
    for (const kind of ['network', 'forbidden', 'other'] as const) {
      expect(refreshWarning(loadFailed(loaded, fail(kind)))).not.toMatch(/remov|revok|transfer|could not (remove|revoke|transfer)|failed/i)
    }
  })

  // 6. classification and notices untouched
  it('the failure kind still comes from the service classification (messages are the existing ones)', () => {
    expect(membersView(loadFailed(MEMBERS_INITIAL, fail('other', 'Could not load members. Please try again.')), true)).toBe('error')
  })
})
