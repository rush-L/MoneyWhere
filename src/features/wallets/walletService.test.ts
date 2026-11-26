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

/** Fake of `from('wallets').delete().eq('id', id).select('id')`. */
const delClient = (res: { data?: unknown[] | null; error?: unknown }) => {
  const select = vi.fn().mockResolvedValue({ data: [], error: null, ...res })
  const eq = vi.fn(() => ({ select }))
  const del = vi.fn(() => ({ eq }))
  const from = vi.fn(() => ({ delete: del }))
  return { from, del, eq, svc: createWalletService({ from } as unknown as SupabaseClient) }
}

describe('wallet delete', () => {
  it('deletes only the given wallet', async () => {
    const c = delClient({ data: [{ id: 'w1' }] })
    await c.svc.remove('w1')
    expect(c.from).toHaveBeenCalledWith('wallets')
    expect(c.eq).toHaveBeenCalledWith('id', 'w1')
  })
  it('no row deleted (RLS: not the owner, or already gone) is an error, never a silent success', async () => {
    await expect(delClient({ data: [] }).svc.remove('w1')).rejects.toBeInstanceOf(WalletError)
    await expect(delClient({ data: [] }).svc.remove('w1')).rejects.toThrow('Only the wallet owner')
  })
  it('a server error becomes a user-safe message without the raw error', async () => {
    const err = delClient({ error: { message: 'secret db detail', code: 'XX000' } }).svc.remove('w1')
    await expect(err).rejects.toBeInstanceOf(WalletError)
    await expect(err).rejects.not.toThrow(/secret/)
  })
})

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
