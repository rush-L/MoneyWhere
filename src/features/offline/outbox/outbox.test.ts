import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it } from 'vitest'
import { openOfflineDb } from '../db/idb'
import { expense, freshStores, queued } from '../testing'
import { createOutbox } from './outbox'

describe('outbox', () => {
  it('queues PENDING with the owner, the payload and the same UUID', async () => {
    const { outbox } = await freshStores()
    await outbox.enqueue(queued('t1', 'userA', expense({ note: 'lunch' })))
    const [i] = await outbox.list('userA')
    expect(i).toMatchObject({ id: 't1', user_id: 'userA', wallet_id: 'w1', status: 'PENDING', attempt_count: 0, last_error: null })
    expect(i!.payload).toEqual(expense({ note: 'lunch' }))
    expect(Object.keys(i!.payload!)).not.toContain('created_by')
    expect(JSON.stringify(i)).not.toMatch(/token|password|secret/i)
  })
  it('lists only the asked user, oldest first', async () => {
    const { outbox } = await freshStores()
    await outbox.enqueue(queued('t1', 'A'))
    await outbox.enqueue(queued('x1', 'B'))
    await outbox.enqueue(queued('t2', 'A'))
    await outbox.enqueue(queued('t3', 'A'))
    expect((await outbox.list('A')).map((i) => i.id)).toEqual(['t1', 't2', 't3'])
    expect((await outbox.list('B')).map((i) => i.id)).toEqual(['x1'])
  })
  it('records attempts and errors; FAILED/PENDING stay syncable, BLOCKED does not', async () => {
    const { outbox } = await freshStores()
    for (const id of ['a', 'b', 'c']) await outbox.enqueue(queued(id, 'A'))
    await outbox.markSyncing((await outbox.list('A'))[0]!)
    expect((await outbox.list('A'))[0]).toMatchObject({ status: 'SYNCING', attempt_count: 1 })
    await outbox.markFailed('a', 'HTTP 503')
    await outbox.markBlocked('b', '42501: denied')
    expect((await outbox.list('A')).map((i) => [i.status, i.last_error])).toEqual([['FAILED', 'HTTP 503'], ['BLOCKED', '42501: denied'], ['PENDING', null]])
    expect((await outbox.listSyncable('A')).map((i) => i.id)).toEqual(['a', 'c'])
  })
  it('complete removes the record (SYNCED is never stored)', async () => {
    const { outbox } = await freshStores()
    await outbox.enqueue(queued('t1', 'A'))
    await outbox.complete('t1')
    expect(await outbox.list('A')).toEqual([])
  })
  it('a duplicate UUID is refused, not queued twice', async () => {
    const { outbox } = await freshStores()
    await outbox.enqueue(queued('t1', 'A'))
    await expect(outbox.enqueue(queued('t1', 'A'))).rejects.toBeDefined()
    expect(await outbox.list('A')).toHaveLength(1)
  })
  it('resetSyncing returns a crashed SYNCING item to PENDING', async () => {
    const { outbox } = await freshStores()
    await outbox.enqueue(queued('t1', 'A'))
    await outbox.markSyncing((await outbox.list('A'))[0]!)
    await outbox.resetSyncing('A')
    expect((await outbox.list('A'))[0]!.status).toBe('PENDING')
  })
  it('survives a "page refresh" (reopening the same database)', async () => {
    const f = new IDBFactory()
    await createOutbox(await openOfflineDb(f, 'x')).enqueue(queued('t1', 'A'))
    expect(await createOutbox(await openOfflineDb(f, 'x')).list('A')).toHaveLength(1)
  })
})
