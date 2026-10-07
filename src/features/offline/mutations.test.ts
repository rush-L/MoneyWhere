import { describe, expect, it } from 'vitest'
import { accountBalance, spendingByBudgetCategory, type Transaction } from '../../domain/finance'
import type { Account } from '../accounts/account'
import type { Category } from '../categories/category'
import type { TransactionRow } from '../transactions/transaction'
import { OutboxBusyError, type OutboxItem } from './outbox/outbox'
import { localBalances, localSpend, mergeLocal } from './outbox/projection'
import { sendItem } from './sync/sendItem'
import { syncOutbox } from './sync/syncEngine'
import { expense, freshStores, queued } from './testing'

const srv = (id: string, o: Partial<TransactionRow> = {}): TransactionRow => ({
  id, type: 'expense', account_id: 'cash', destination_account_id: null, category_id: 'food', amount_minor: 50000, date: '2026-10-10', note: null,
  created_by: 'A', paid_by_user_id: 'A', version: 5, ...o,
})
const edit = (id: string, payload = expense({ amount_minor: 60000 }), o: { expected_version?: number; base?: TransactionRow } = {}) =>
  ({ id, user_id: 'A', wallet_id: 'w1', expected_version: 5, base: srv(id), payload, ...o })
const gone = (id: string, o: { expected_version?: number | null; base?: TransactionRow | null } = {}) =>
  ({ id, user_id: 'A', wallet_id: 'w1', expected_version: 5, base: srv(id), ...o })
const open = async (s: Awaited<ReturnType<typeof freshStores>>) => s.outbox.list('A')

describe('outbox: edit/delete fold into one open item per transaction', () => {
  it('offline create + edit = ONE create with the latest payload', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A', expense({ amount_minor: 50000 })))
    await s.outbox.edit(edit('t1', expense({ amount_minor: 60000, note: 'x' })))
    const items = await open(s)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ op: 'CREATE', payload: expense({ amount_minor: 60000, note: 'x' }) })
  })
  it('offline create + delete = nothing is queued', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A'))
    await s.outbox.remove(gone('t1', { expected_version: null, base: null }))
    expect(await open(s)).toEqual([])
  })
  it('update + update = one update: latest payload, original expected_version and mutation id', async () => {
    const s = await freshStores()
    await s.outbox.edit(edit('t1', expense({ amount_minor: 60000 })))
    const [first] = await open(s)
    await s.outbox.edit(edit('t1', expense({ amount_minor: 70000 }), { expected_version: 99 }))
    const items = await open(s)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ op: 'UPDATE', expected_version: 5, mutation_id: first!.mutation_id, payload: expense({ amount_minor: 70000 }) })
  })
  it('update + delete = one delete at the update\'s expected_version', async () => {
    const s = await freshStores()
    await s.outbox.edit(edit('t1'))
    await s.outbox.remove(gone('t1', { expected_version: 7 }))
    const items = await open(s)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ op: 'DELETE', expected_version: 5, payload: null })
  })
  it('a delete on a synced row queues one DELETE with a mutation id', async () => {
    const s = await freshStores()
    await s.outbox.remove(gone('t1'))
    expect((await open(s))[0]).toMatchObject({ op: 'DELETE', expected_version: 5, status: 'PENDING', payload: null, mutation_id: expect.any(String) })
  })
  it('an item that may have reached the server cannot be rewritten (a lost response would swallow the edit)', async () => {
    for (const mark of ['syncing', 'inDoubt', 'conflict', 'blocked'] as const) {
      const s = await freshStores()
      await s.outbox.edit(edit('t1'))
      const [i] = await open(s)
      if (mark === 'syncing') await s.outbox.markSyncing(i!)
      if (mark === 'inDoubt') { await s.outbox.markSyncing(i!); await s.outbox.markPending('t1', 'network') }
      if (mark === 'conflict') await s.outbox.markConflict('t1', 'x')
      if (mark === 'blocked') await s.outbox.markBlocked('t1', 'x')
      await expect(s.outbox.edit(edit('t1', expense({ amount_minor: 1 })))).rejects.toBeInstanceOf(OutboxBusyError)
      await expect(s.outbox.remove(gone('t1'))).rejects.toBeInstanceOf(OutboxBusyError)
      expect((await open(s))[0]!.payload).toEqual(expense({ amount_minor: 60000 })) // untouched
    }
  })
  it('a queued delete cannot be edited; deleting twice is a no-op', async () => {
    const s = await freshStores()
    await s.outbox.remove(gone('t1'))
    await expect(s.outbox.edit(edit('t1'))).rejects.toBeInstanceOf(OutboxBusyError)
    await s.outbox.remove(gone('t1'))
    expect(await open(s)).toHaveLength(1)
  })
  it('another user\'s item is never folded into', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'B'))
    await expect(s.outbox.edit(edit('t1'))).rejects.toBeInstanceOf(OutboxBusyError)
    expect((await s.outbox.list('B'))[0]!.payload).toEqual(expense())
  })
  it('discard drops only CONFLICT/BLOCKED items', async () => {
    const s = await freshStores()
    await s.outbox.edit(edit('t1'))
    await s.outbox.discard('t1')
    expect(await open(s)).toHaveLength(1) // still pending: not discardable
    await s.outbox.markConflict('t1', 'x')
    await s.outbox.discard('t1')
    expect(await open(s)).toEqual([])
  })
  it('items saved before Phase 11B read back as CREATEs', async () => {
    const s = await freshStores()
    await s.outbox.enqueue(queued('t1', 'A'))
    expect((await open(s))[0]).toMatchObject({ op: 'CREATE', expected_version: null, mutation_id: null, base: null })
  })
})

const item = (op: 'UPDATE' | 'DELETE', id: string, o: Partial<OutboxItem> = {}): OutboxItem => ({
  seq: 1, id, user_id: 'A', wallet_id: 'w1', created_at: '', status: 'PENDING', attempt_count: 0, last_error: null,
  op, expected_version: 5, mutation_id: `m-${id}`, base: srv(id), payload: op === 'UPDATE' ? row({ amount_minor: 60000 }) : null, ...o,
})
// the edited payload for srv(): same account/category unless a test changes them
const row = (o: Partial<ReturnType<typeof expense>> = {}) => expense({ account_id: 'cash', category_id: 'food', ...o })
const acct = (id: string, bal: number) => ({ id, currentBalanceMinor: bal }) as Account
const bal = (accounts: Account[], server: readonly { id: string }[], items: OutboxItem[]) => localBalances(accounts, server, items, 'w1').map((a) => a.currentBalanceMinor)

describe('projection: pending UPDATE / DELETE over the server baseline', () => {
  it('lists: update overlays in place, delete excludes, others untouched', () => {
    const server = [srv('a'), srv('b'), srv('c')]
    const rows = mergeLocal(server, [item('UPDATE', 'a'), item('DELETE', 'b')], 'w1')
    expect(rows.map((r) => r.id)).toEqual(['a', 'c'])
    expect(rows[0]).toMatchObject({ amount_minor: 60000, sync: 'PENDING', version: 5, created_by: 'A' })
  })
  it('balance = server balance with the old state taken out and the new one applied (accountBalance only)', () => {
    // server counts the 500 expense: cash 1000 - 500 = 500. Edit to 600 -> 400. Delete -> 1000.
    expect(bal([acct('cash', 50000)], [srv('a')], [item('UPDATE', 'a')])).toEqual([40000])
    expect(bal([acct('cash', 50000)], [srv('a')], [item('DELETE', 'a')])).toEqual([100000])
  })
  it('moving an expense to another account / turning it into income moves both balances', () => {
    const moved = item('UPDATE', 'a', { payload: row({ account_id: 'bpi' }) })
    expect(bal([acct('cash', 50000), acct('bpi', 80000)], [srv('a')], [moved])).toEqual([100000, 30000])
    const flipped = item('UPDATE', 'a', { payload: row({ type: 'income', category_id: null }) })
    expect(bal([acct('cash', 50000)], [srv('a')], [flipped])).toEqual([150000])
  })
  it('transfers: editing the amount moves both sides', () => {
    const t = srv('t', { type: 'transfer', account_id: 'cash', destination_account_id: 'bpi', category_id: null, amount_minor: 10000 })
    const e = item('UPDATE', 't', { base: t, payload: expense({ type: 'transfer', account_id: 'cash', destination_account_id: 'bpi', category_id: null, amount_minor: 30000 }) })
    expect(bal([acct('cash', 90000), acct('bpi', 10000)], [t], [e])).toEqual([70000, 30000])
  })
  it('matches what the server would hold after the sync (the reference formula)', () => {
    const before: Transaction[] = [srv('a'), srv('b', { amount_minor: 20000 })]
    const serverNow = accountBalance('cash', 100000, before)
    const after: Transaction[] = [{ ...srv('a'), amount_minor: 60000 }]
    expect(bal([acct('cash', serverNow)], before, [item('UPDATE', 'a'), item('DELETE', 'b')])).toEqual([accountBalance('cash', 100000, after)])
  })
  it('works offline: with no server row to hand, the item\'s own baseline is used', () => {
    expect(bal([acct('cash', 50000)], [], [item('UPDATE', 'a')])).toEqual([40000])
    expect(bal([acct('cash', 50000)], [{ id: 'a' }], [item('DELETE', 'a')])).toEqual([100000]) // a bare id proves nothing more
  })
  it('stale (server version moved on), CONFLICT and BLOCKED items change nothing: the server row stands', () => {
    const server = [srv('a', { version: 6, amount_minor: 70000 })]
    const stale = item('UPDATE', 'a')
    expect(bal([acct('cash', 30000)], server, [stale])).toEqual([30000])
    expect(mergeLocal(server, [stale], 'w1')[0]).toMatchObject({ amount_minor: 70000, sync: 'CONFLICT' })
    for (const status of ['CONFLICT', 'BLOCKED'] as const) {
      expect(bal([acct('cash', 50000)], [srv('a')], [item('UPDATE', 'a', { status })])).toEqual([50000])
      expect(mergeLocal([srv('a')], [item('DELETE', 'a', { status })], 'w1')).toHaveLength(1) // a failed delete keeps the row visible
    }
  })
  it('a stale DELETE keeps the row; a Realtime refresh does not drop the pending item', () => {
    const server = [srv('a', { version: 6 })]
    expect(mergeLocal(server, [item('DELETE', 'a')], 'w1')).toHaveLength(1)
    // same item, server unchanged after a refresh: still applied
    expect(mergeLocal([srv('a')], [item('DELETE', 'a')], 'w1')).toHaveLength(0)
  })
  it('spend: an edited expense replaces the server row; a deleted one disappears; income never counts', () => {
    const cats = [{ id: 'food', parentId: null }] as unknown as Category[]
    const spend = [{ id: 'a', type: 'expense', category_id: 'food', amount_minor: 50000, date: '2026-10-10', account_id: 'cash' }]
    const total = (items: OutboxItem[]) => spendingByBudgetCategory(localSpend(spend, [], items, 'w1') as Transaction[], cats, '2026-10').get('food') ?? 0
    expect(total([])).toBe(50000)
    expect(total([item('UPDATE', 'a')])).toBe(60000)
    expect(total([item('DELETE', 'a')])).toBe(0)
    expect(total([item('UPDATE', 'a', { payload: row({ type: 'income', category_id: null }) })])).toBe(0)
  })
  it('other wallets\' items are ignored', () => {
    expect(bal([acct('cash', 50000)], [srv('a')], [item('DELETE', 'a', { wallet_id: 'w2' })])).toEqual([50000])
  })
})

describe('sync: UPDATE / DELETE replay', () => {
  const svcReturning = (status: string) => ({
    send: async () => {},
    mutate: async () => ({ status }) as never,
  })
  it('maps RPC outcomes: applied / replay / already-gone are success, conflict is data, forbidden is permanent', async () => {
    for (const ok of ['APPLIED', 'ALREADY_APPLIED', 'ALREADY_GONE']) expect(await sendItem(svcReturning(ok), item('DELETE', 'a'))).toBe('ok')
    expect(await sendItem(svcReturning('CONFLICT'), item('UPDATE', 'a'))).toBe('conflict')
    await expect(sendItem(svcReturning('FORBIDDEN'), item('UPDATE', 'a'))).rejects.toThrow(/not yours/)
  })
  it('replay is always own-only and carries the item\'s mutation id and expected version', async () => {
    const seen: unknown[] = []
    await sendItem({ send: async () => {}, mutate: async (m: unknown) => (seen.push(m), { status: 'APPLIED' as const, version: 6 }) }, item('UPDATE', 'a'))
    expect(seen[0]).toMatchObject({ mutationId: 'm-a', op: 'UPDATE', id: 'a', expectedVersion: 5, ownOnly: true })
  })
  it('a CONFLICT item is marked, kept visible, never retried, and does not stop later items', async () => {
    const s = await freshStores()
    await s.outbox.edit(edit('t1'))
    await s.outbox.edit(edit('t2'))
    const sent: string[] = []
    const run = () => syncOutbox({
      outbox: s.outbox, userId: 'A', currentUserId: () => 'A',
      send: async (i) => { sent.push(i.id); return i.id === 't1' ? 'conflict' : 'ok' },
    })
    expect(await run()).toEqual({ synced: 1, conflicted: 1, stoppedBy: null })
    expect((await open(s)).map((i) => [i.id, i.status])).toEqual([['t1', 'CONFLICT']])
    await run()
    expect(sent).toEqual(['t1', 't2']) // t1 not retried
  })
  it('user isolation: A\'s queued update is never sent under B\'s session and stays untouched', async () => {
    const s = await freshStores()
    await s.outbox.edit(edit('t1'))
    const sent: string[] = []
    const r = await syncOutbox({ outbox: s.outbox, userId: 'B', currentUserId: () => 'B', send: async (i) => void sent.push(i.id) })
    expect(r.synced).toBe(0)
    expect(sent).toEqual([])
    expect((await open(s))[0]).toMatchObject({ status: 'PENDING', attempt_count: 0 })
    const back = await syncOutbox({ outbox: s.outbox, userId: 'A', currentUserId: () => 'A', send: async (i) => void sent.push(i.id) })
    expect(back.synced).toBe(1) // A signs back in: eligible again
  })
})
