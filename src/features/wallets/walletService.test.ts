import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createWalletService, WalletError } from './walletService'

vi.spyOn(console, 'error').mockImplementation(() => {})

/** Fake of `from('wallets').update(patch).eq('id', id).select('id')`. */
const client = (res: { data?: unknown[] | null; error?: unknown }) => {
  const select = vi.fn().mockResolvedValue({ data: [], error: null, ...res })
  const eq = vi.fn(() => ({ select }))
  const update = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ update }))
  return { from, update, eq, svc: createWalletService({ from } as unknown as SupabaseClient) }
}

describe('wallet rename', () => {
  it('updates only the name of the given wallet', async () => {
    const c = client({ data: [{ id: 'w1' }] })
    await c.svc.rename('w1', 'Home')
    expect(c.from).toHaveBeenCalledWith('wallets')
    expect(c.update).toHaveBeenCalledWith({ name: 'Home' })
    expect(c.eq).toHaveBeenCalledWith('id', 'w1')
  })
  it('no row updated (RLS: not the owner) is an error, never a silent success', async () => {
    await expect(client({ data: [] }).svc.rename('w1', 'Home')).rejects.toBeInstanceOf(WalletError)
    await expect(client({ data: [] }).svc.rename('w1', 'Home')).rejects.toThrow('Only the wallet owner')
  })
  it('a server error becomes a user-safe message without the raw error', async () => {
    const err = client({ error: { message: 'secret db detail', code: 'XX000' } }).svc.rename('w1', 'Home')
    await expect(err).rejects.toBeInstanceOf(WalletError)
    await expect(err).rejects.not.toThrow(/secret/)
  })
})
