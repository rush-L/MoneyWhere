import { describe, expect, it } from 'vitest'
import { hasPendingForWallet, parseWalletName, walletFromRow } from './wallet'

describe('hasPendingForWallet', () => {
  it('any queued item of this wallet blocks, in any status', () => {
    for (const status of ['PENDING', 'SYNCING', 'FAILED', 'BLOCKED', 'CONFLICT']) expect(hasPendingForWallet([{ wallet_id: 'w1', status }], 'w1')).toBe(true)
  })
  it('items of other wallets and an empty queue do not', () => {
    expect(hasPendingForWallet([{ wallet_id: 'w2' }], 'w1')).toBe(false)
    expect(hasPendingForWallet([], 'w1')).toBe(false)
  })
})

describe('walletFromRow', () => {
  const row = { id: 'w', name: 'Home', currency: 'PHP', mode: 'shared_log', created_at: 'c' }
  it('maps owner and member roles', () => {
    expect(walletFromRow({ ...row, wallet_members: [{ role: 'owner' }] })).toEqual({
      id: 'w', name: 'Home', currency: 'PHP', mode: 'shared_log', role: 'owner', createdAt: 'c',
    })
    expect(walletFromRow({ ...row, wallet_members: [{ role: 'member' }] }).role).toBe('member')
  })
  it('defaults to the least-privileged role when membership is missing', () => {
    expect(walletFromRow({ ...row, wallet_members: [] }).role).toBe('member')
  })
})

describe('parseWalletName', () => {
  it('trims', () => expect(parseWalletName('  Home ')).toEqual({ ok: true, name: 'Home' }))
  it('rejects empty and over-long', () => {
    expect(parseWalletName('   ').ok).toBe(false)
    expect(parseWalletName('x'.repeat(51)).ok).toBe(false)
    expect(parseWalletName('x'.repeat(50)).ok).toBe(true)
  })
})
