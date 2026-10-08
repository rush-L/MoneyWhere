import { IDBKeyRange } from 'fake-indexeddb'
import { beforeAll, describe, expect, it } from 'vitest'
import { expense, freshStores, queued } from '../testing'
import { walletKey, walletsKey } from './cache'

// Browsers provide the IDBKeyRange global; the fake IndexedDB used in tests only exports it.
beforeAll(() => {
  ;(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange
})

describe('cache.clearUser (account deletion privacy)', () => {
  it('removes only that user\'s snapshots; another user, even with a similar id, and the outbox are untouched', async () => {
    const { cache, outbox } = await freshStores()
    for (const u of ['u1', 'u1x', 'u10']) {
      await cache.put(walletsKey(u), [{ id: 'w' }])
      await cache.put(walletKey(u, 'w1'), { accounts: [] })
    }
    await outbox.enqueue(queued('t1', 'u1', expense()))
    await cache.clearUser('u1')
    expect(await cache.get(walletsKey('u1'))).toBeNull()
    expect(await cache.get(walletKey('u1', 'w1'))).toBeNull()
    for (const u of ['u1x', 'u10']) {
      expect(await cache.get(walletsKey(u))).not.toBeNull()
      expect(await cache.get(walletKey(u, 'w1'))).not.toBeNull()
    }
    expect(await outbox.list('u1')).toHaveLength(1) // never touched
  })
  it('is harmless for an unknown user or when repeated', async () => {
    const { cache } = await freshStores()
    await cache.put(walletsKey('a'), [1])
    await cache.clearUser('nobody')
    await cache.clearUser('nobody')
    expect(await cache.get(walletsKey('a'))).toEqual([1])
  })
})

describe('outbox.hasAny (account deletion guard)', () => {
  it('is true for an item in every status, and only for that user', async () => {
    for (const mark of ['PENDING', 'SYNCING', 'FAILED', 'BLOCKED', 'CONFLICT'] as const) {
      const { outbox } = await freshStores()
      expect(await outbox.hasAny('A')).toBe(false)
      await outbox.enqueue(queued('t1', 'A', expense()))
      if (mark === 'SYNCING') await outbox.markSyncing({ id: 't1' })
      if (mark === 'FAILED') await outbox.markFailed('t1', 'x')
      if (mark === 'BLOCKED') await outbox.markBlocked('t1', 'x')
      if (mark === 'CONFLICT') await outbox.markConflict('t1', 'x')
      expect((await outbox.list('A'))[0]!.status).toBe(mark)
      expect(await outbox.hasAny('A'), mark).toBe(true)
      expect(await outbox.hasAny('B')).toBe(false)
      expect((await outbox.list('A')).length, 'reading never changes the outbox').toBe(1)
    }
  })
  it('turns false only when the item is genuinely resolved', async () => {
    const { outbox } = await freshStores()
    await outbox.enqueue(queued('t1', 'A', expense()))
    await outbox.complete('t1')
    expect(await outbox.hasAny('A')).toBe(false)
  })
})
