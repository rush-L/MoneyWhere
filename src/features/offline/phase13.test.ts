import { afterEach, describe, expect, it, vi } from 'vitest'
import { readThrough } from './db/cache'
import { OutboxBusyError, type OutboxItem } from './outbox/outbox'
import { syncOutbox } from './sync/syncEngine'
import { describeSync } from './syncLabels'
import { expense, freshStores, queued } from './testing'

const edit = (id: string, amount: number) => ({ id, user_id: 'A', wallet_id: 'w1', expected_version: 1, base: null as never, payload: expense({ amount_minor: amount }) })

describe('sync sends what is stored at send time (offline create -> edit stays safe)', () => {
  it('an edit made after the run listed the items, before it reached them, is what gets sent', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A'))
    await s.outbox.enqueue(queued('t2', 'A', expense({ amount_minor: 100 })))
    const sent: [string, number | undefined][] = []
    await syncOutbox({
      outbox: s.outbox, userId: 'A', currentUserId: () => 'A',
      send: async (i: OutboxItem) => {
        sent.push([i.id, i.payload?.amount_minor])
        if (i.id === 't1') await s.outbox.edit(edit('t2', 999)) // user edits t2 while t1 is on the wire
      },
    })
    expect(sent).toEqual([['t1', 50000], ['t2', 999]])
  })
  it('an item removed after listing is not sent', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A'))
    await s.outbox.enqueue(queued('t2', 'A'))
    const sent: string[] = []
    await syncOutbox({
      outbox: s.outbox, userId: 'A', currentUserId: () => 'A',
      send: async (i: OutboxItem) => {
        sent.push(i.id)
        if (i.id === 't1') await s.outbox.remove({ id: 't2', user_id: 'A', wallet_id: 'w1', expected_version: null, base: null })
      },
    })
    expect(sent).toEqual(['t1'])
    expect(await s.outbox.list('A')).toEqual([])
  })
  it('an item that was attempted (may be on the server) refuses edits with an explanation', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A'))
    await s.outbox.markSyncing({ id: 't1' })
    await s.outbox.markPending('t1', 'network')
    await expect(s.outbox.edit(edit('t1', 1))).rejects.toThrow(OutboxBusyError)
    await expect(s.outbox.edit(edit('t1', 1))).rejects.toThrow(/already attempted/)
  })
})

describe('readThrough offline', () => {
  afterEach(() => vi.unstubAllGlobals())
  it('uses the snapshot without calling the network', async () => {
    const { cache } = await freshStores()
    await cache.put('k', { n: 1 })
    vi.stubGlobal('navigator', { onLine: false })
    const fetcher = vi.fn(async () => ({ n: 2 }))
    expect(await readThrough(cache, 'k', fetcher)).toEqual({ data: { n: 1 }, stale: true })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('offline without a snapshot still tries the fetcher; online stays network-first', async () => {
    const { cache } = await freshStores()
    vi.stubGlobal('navigator', { onLine: false })
    const fetcher = vi.fn(async () => ({ n: 2 }))
    expect((await readThrough(cache, 'none', fetcher)).stale).toBe(false)
    vi.stubGlobal('navigator', { onLine: true })
    await cache.put('k', { n: 1 })
    expect(await readThrough(cache, 'k', fetcher)).toEqual({ data: { n: 2 }, stale: false })
  })
})

describe('describeSync', () => {
  it('only a never-sent pending item is editable; warnings are plain language', () => {
    expect(describeSync('PENDING', false).editable).toBe(true)
    for (const [st, att] of [['PENDING', true], ['SYNCING', true], ['FAILED', true], ['BLOCKED', true], ['CONFLICT', true]] as const) expect(describeSync(st, att).editable).toBe(false)
    expect(describeSync('CONFLICT', true).text).toMatch(/server version/i)
    expect(describeSync('BLOCKED', true).text).toMatch(/rejected/)
    expect(describeSync('FAILED', true).text).toMatch(/retried automatically/)
    for (const st of ['PENDING', 'SYNCING', 'FAILED', 'BLOCKED', 'CONFLICT'] as const) expect(describeSync(st, true).text).not.toMatch(/PGRST|42501|supabase/i)
  })
})
