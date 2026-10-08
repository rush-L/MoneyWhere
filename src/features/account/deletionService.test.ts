import type { SupabaseClient } from '@supabase/supabase-js'
import { describe, expect, it, vi } from 'vitest'
import { createDeletionService, DeletionError, parsePlan } from './deletionService'

const client = (res: { data?: unknown; error?: unknown }) => {
  const rpc = vi.fn().mockResolvedValue({ data: null, error: null, ...res })
  return { rpc, svc: createDeletionService({ rpc } as unknown as SupabaseClient) }
}
vi.spyOn(console, 'error').mockImplementation(() => {})

describe('parsePlan', () => {
  it('maps the database answer', () => {
    expect(parsePlan({ blocking: [{ id: 'w1', name: 'Family', other_members: 2 }], will_delete: [{ id: 'w2', name: 'Solo' }], leaving: [{ id: 'w3', name: 'Theirs' }] })).toEqual({
      blocking: [{ id: 'w1', name: 'Family', otherMembers: 2 }], willDelete: [{ id: 'w2', name: 'Solo' }], leaving: [{ id: 'w3', name: 'Theirs' }],
    })
  })
  it('rejects anything unexpected instead of guessing', () => {
    expect(() => parsePlan(null)).toThrow()
    expect(() => parsePlan({ blocking: [], will_delete: [{ id: 1 }], leaving: [] })).toThrow()
    expect(() => parsePlan({ blocking: [], will_delete: [] })).toThrow()
  })
})

describe('deletion service', () => {
  it('preview calls the RPC with no arguments (no user id)', async () => {
    const { rpc, svc } = client({ data: { blocking: [], will_delete: [], leaving: [] } })
    expect(await svc.preview()).toEqual({ blocking: [], willDelete: [], leaving: [] })
    expect(rpc).toHaveBeenCalledWith('account_deletion_preview')
  })
  it('delete sends only the confirmed wallet ids', async () => {
    const { rpc, svc } = client({ data: { ok: true } })
    expect(await svc.deleteAccount(['w1', 'w2'])).toEqual({ ok: true })
    expect(rpc).toHaveBeenCalledWith('delete_my_account', { p_confirmed_wallet_ids: ['w1', 'w2'] })
  })
  it('maps blocked and changed results', async () => {
    expect(await client({ data: { ok: false, reason: 'blocked', wallets: [{ id: 'w', name: 'F', other_members: 1 }] } }).svc.deleteAccount([])).toEqual({ ok: false, reason: 'blocked', wallets: [{ id: 'w', name: 'F', otherMembers: 1 }] })
    expect(await client({ data: { ok: false, reason: 'changed' } }).svc.deleteAccount([])).toEqual({ ok: false, reason: 'changed' })
  })
  it('an unrecognised answer is an error, never success', async () => {
    await expect(client({ data: { ok: 'yes' } }).svc.deleteAccount([])).rejects.toBeInstanceOf(DeletionError)
    await expect(client({ data: null }).svc.deleteAccount([])).rejects.toBeInstanceOf(DeletionError)
  })
  it('a network failure on delete says the outcome is unknown; on preview it does not', async () => {
    const net = { message: 'TypeError: Failed to fetch' }
    await expect(client({ error: net }).svc.deleteAccount([])).rejects.toMatchObject({ outcomeUnknown: true })
    await expect(client({ error: net }).svc.preview()).rejects.toMatchObject({ outcomeUnknown: false })
  })
  it('a server failure on delete says nothing was deleted; an expired session asks to sign in', async () => {
    await expect(client({ error: { code: '57014', message: 'timeout', status: 500 } }).svc.deleteAccount([])).rejects.toThrow(/Nothing was deleted/)
    await expect(client({ error: { code: '28000', message: 'not authenticated' } }).svc.deleteAccount([])).rejects.toThrow(/sign in again/)
  })
})
