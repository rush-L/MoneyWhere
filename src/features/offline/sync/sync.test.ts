import { describe, expect, it } from 'vitest'
import { createTransactionService } from '../../transactions/transactionService'
import { expense, fakeServer, freshStores, queued } from '../testing'
import { classifyFailure, IntegrityError } from './errors'
import { createSyncer, syncOutbox } from './syncEngine'

type Stores = Awaited<ReturnType<typeof freshStores>>

function setup(user = 'A', opts?: Parameters<typeof fakeServer>[1]) {
  const state = { user }
  const server = fakeServer(() => state.user, opts)
  const svc = createTransactionService(server.client)
  const run = (stores: Stores, as = state.user) =>
    syncOutbox({ outbox: stores.outbox, userId: as, currentUserId: () => state.user, send: (i) => svc.send(i.id, i.user_id, i.payload!) })
  return { state, server, svc, run }
}

describe('replay + idempotency', () => {
  it('sends queued items oldest first, once each, then drains the outbox', async () => {
    const s = await freshStores()
    const { server, run } = setup()
    for (const id of ['t1', 't2', 't3']) await s.outbox.enqueue(queued(id, 'A'))
    expect(await run(s)).toEqual({ synced: 3, conflicted: 0, stoppedBy: null })
    expect(server.sent).toEqual(['t1', 't2', 't3'])
    expect(await s.outbox.list('A')).toEqual([])
  })
  it('lost response: server committed, client saw a network error, retry creates no duplicate', async () => {
    const s = await freshStores()
    let lose = true
    const { server, run } = setup('A', { loseResponse: () => lose })
    await s.outbox.enqueue(queued('t1', 'A'))
    expect(await run(s)).toMatchObject({ synced: 0, conflicted: 0, stoppedBy: 'network' })
    expect((await s.outbox.list('A'))[0]).toMatchObject({ status: 'PENDING', attempt_count: 1 })
    lose = false
    expect(await run(s)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect([...server.rows.keys()]).toEqual(['t1']) // one row
    expect(server.sent).toEqual(['t1']) // the retry never inserted again
    expect(await s.outbox.list('A')).toEqual([])
  })
  it('same UUID already created by someone else: BLOCKED, not overwritten', async () => {
    const s = await freshStores()
    const { server, run } = setup('A')
    server.rows.set('t1', 'B') // a row B created, visible to A (same wallet)
    await s.outbox.enqueue(queued('t1', 'A'))
    expect(await run(s)).toMatchObject({ synced: 0, conflicted: 0, stoppedBy: null })
    const [i] = await s.outbox.list('A')
    expect(i).toMatchObject({ status: 'BLOCKED' })
    expect(i!.last_error).toMatch(/not yours/)
    expect(server.rows.get('t1')).toBe('B')
  })
  it('UUID exists but is invisible to this user (other wallet): BLOCKED', async () => {
    const s = await freshStores()
    const { server, run } = setup('A', { visible: () => false })
    server.rows.set('t1', 'someone-else')
    await s.outbox.enqueue(queued('t1', 'A'))
    await run(s)
    expect((await s.outbox.list('A'))[0]!.status).toBe('BLOCKED')
    expect(server.rows.get('t1')).toBe('someone-else')
  })
  it('a permanent rejection blocks that item but later ones still sync; payload is never altered', async () => {
    const s = await freshStores()
    const base = createTransactionService(fakeServer(() => 'A').client)
    await s.outbox.enqueue(queued('bad', 'A', expense({ account_id: 'gone' })))
    await s.outbox.enqueue(queued('ok', 'A'))
    const r = await syncOutbox({
      outbox: s.outbox, userId: 'A', currentUserId: () => 'A',
      send: (i) => (i.payload!.account_id === 'gone' ? Promise.reject({ code: '42501', message: 'rls', status: 403 }) : base.send(i.id, i.user_id, i.payload!)),
    })
    expect(r.synced).toBe(1)
    expect((await s.outbox.list('A'))[0]).toMatchObject({ id: 'bad', status: 'BLOCKED', payload: expense({ account_id: 'gone' }) })
  })
})

describe('user isolation', () => {
  it("B's session never sends A's queue; A signing back in does", async () => {
    const s = await freshStores()
    const { state, server, run } = setup('A')
    await s.outbox.enqueue(queued('a1', 'A'))
    state.user = 'B'
    expect(await run(s, 'B')).toEqual({ synced: 0, conflicted: 0, stoppedBy: null })
    expect(server.sent).toEqual([])
    expect((await s.outbox.list('A'))[0]!.status).toBe('PENDING') // untouched, not quarantined
    state.user = 'A'
    expect(await run(s, 'A')).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(server.rows.get('a1')).toBe('A')
  })
  it('defence in depth: an item whose user_id mismatches the run is BLOCKED and never sent', async () => {
    const s = await freshStores()
    const { server, svc } = setup('B')
    await s.outbox.enqueue(queued('a1', 'A'))
    const leaky = { ...s.outbox, listSyncable: () => s.outbox.list('A') } // simulate a bad query
    const r = await syncOutbox({ outbox: leaky, userId: 'B', currentUserId: () => 'B', send: (i) => svc.send(i.id, i.user_id, i.payload!) })
    expect(r.synced).toBe(0)
    expect(server.sent).toEqual([])
    const [i] = await s.outbox.list('A')
    expect(i).toMatchObject({ status: 'BLOCKED' })
    expect(i!.last_error).toMatch(/user-mismatch/)
  })
  it('stops when the session user changes mid-run', async () => {
    const s = await freshStores()
    const { state, server, svc } = setup('A')
    await s.outbox.enqueue(queued('a1', 'A'))
    await s.outbox.enqueue(queued('a2', 'A'))
    const r = await syncOutbox({
      outbox: s.outbox, userId: 'A', currentUserId: () => state.user,
      send: async (i) => { await svc.send(i.id, i.user_id, i.payload!); state.user = 'B' },
    })
    expect(r).toEqual({ synced: 1, conflicted: 0, stoppedBy: 'user-changed' })
    expect(server.sent).toEqual(['a1'])
    expect((await s.outbox.list('A'))[0]!.id).toBe('a2')
  })
})

describe('offline -> online transitions', () => {
  it('offline create, reconnect, sync; and a failing request after reconnect keeps it queued', async () => {
    const s = await freshStores()
    let down = true
    const { server, run } = setup('A', { down: () => down })
    await s.outbox.enqueue(queued('t1', 'A'))
    expect(await run(s)).toMatchObject({ synced: 0, conflicted: 0, stoppedBy: 'network' }) // browser "online" but Supabase unreachable
    expect((await s.outbox.list('A'))[0]).toMatchObject({ status: 'PENDING', attempt_count: 1 })
    expect(server.rows.size).toBe(0)
    down = false
    expect(await run(s)).toEqual({ synced: 1, conflicted: 0, stoppedBy: null })
    expect(await s.outbox.list('A')).toEqual([])
    expect(server.rows.size).toBe(1)
  })
  it('a transient server failure marks FAILED, stops the run (keeps order) and is retried next time', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A'))
    await s.outbox.enqueue(queued('t2', 'A'))
    let fail = true
    const sent: string[] = []
    const send = async (i: { id: string }) => {
      if (fail) throw { code: '', message: 'bad gateway', status: 502 }
      sent.push(i.id)
    }
    const deps = { outbox: s.outbox, userId: 'A', currentUserId: () => 'A', send }
    expect(await syncOutbox(deps)).toMatchObject({ stoppedBy: 'transient' })
    expect((await s.outbox.list('A')).map((i) => i.status)).toEqual(['FAILED', 'PENDING'])
    fail = false
    await syncOutbox(deps)
    expect(sent).toEqual(['t1', 't2'])
  })
})

describe('createSyncer', () => {
  it('runs one at a time; a trigger during a run schedules exactly one more', async () => {
    let active = 0, max = 0, runs = 0
    const sync = createSyncer(async () => {
      runs++
      active++
      max = Math.max(max, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
      return { synced: 0, conflicted: 0, stoppedBy: null }
    })
    await Promise.all([sync(), sync(), sync()])
    expect(max).toBe(1)
    expect(runs).toBe(2)
  })
})

describe('classifyFailure', () => {
  it('network vs transient vs permanent', () => {
    expect(classifyFailure(new TypeError('Failed to fetch'))).toBe('network')
    expect(classifyFailure({ message: 'TypeError: Failed to fetch', status: 0 })).toBe('network')
    expect(classifyFailure({ code: '503', status: 503 })).toBe('transient')
    expect(classifyFailure({ code: 'PGRST301', status: 401 })).toBe('transient')
    for (const code of ['42501', '23503', '23514', '22003']) expect(classifyFailure({ code, status: 400 })).toBe('permanent')
    expect(classifyFailure(new IntegrityError('x'))).toBe('permanent')
  })
})
