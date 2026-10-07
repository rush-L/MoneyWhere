import { describe, expect, it } from 'vitest'
import { parseWalletName, walletFromRow } from './wallet'

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
