import { describe, expect, it } from 'vitest'
import { accountBalance, spendingByCategory, transactionTotals } from '../../../domain/finance'
import type { Account } from '../../accounts/account'
import type { TransactionRow } from '../../transactions/transaction'
import { expense } from '../testing'
import type { OutboxItem } from './outbox'
import { countedPending, localBalances, mergeLocal, reconcile } from './projection'

const acct = (id: string, bal: number) => ({ id, currentBalanceMinor: bal }) as Account
const item = (id: string, payload = expense(), status: OutboxItem['status'] = 'PENDING'): OutboxItem =>
  ({ seq: 1, id, user_id: 'A', wallet_id: 'w1', created_at: '', status, attempt_count: 0, last_error: null, payload, op: 'CREATE', expected_version: null, mutation_id: null, base: null })
const srv = (id: string): TransactionRow =>
  ({ id, type: 'expense', account_id: 'acc1', destination_account_id: null, category_id: 'cat1', amount_minor: 50000, date: '2026-10-10', note: null, created_by: 'A', paid_by_user_id: 'A' })

describe('local projection', () => {
  it('pending expense, income and transfer move balances (both sides of a transfer)', () => {
    const items = [
      item('e', expense({ amount_minor: 50000 })),
      item('i', expense({ type: 'income', category_id: null, amount_minor: 20000 })),
      item('t', expense({ type: 'transfer', account_id: 'acc1', destination_account_id: 'acc2', category_id: null, amount_minor: 10000 })),
    ]
    const out = localBalances([acct('acc1', 1_000_000), acct('acc2', 0)], [], items, 'w1')
    expect(out.map((a) => a.currentBalanceMinor)).toEqual([1_000_000 - 50000 + 20000 - 10000, 10000])
  })
  it('uses the domain accountBalance (same numbers as replaying everything)', () => {
    const items = [item('e', expense({ amount_minor: 123 }))]
    expect(localBalances([acct('acc1', 500)], [], items, 'w1')[0]!.currentBalanceMinor).toBe(accountBalance('acc1', 500, countedPending([], items, 'w1')))
  })
  it('does not double count once the server has the row', () => {
    const items = [item('e')]
    expect(localBalances([acct('acc1', 95_000)], [srv('e')], items, 'w1')[0]!.currentBalanceMinor).toBe(95_000)
    expect(mergeLocal([srv('e')], items, 'w1')).toHaveLength(1)
    expect(mergeLocal([srv('e')], items, 'w1')[0]!.sync).toBeUndefined()
  })
  it('BLOCKED items are shown but never counted; other wallets are ignored', () => {
    const items = [item('b', expense(), 'BLOCKED'), { ...item('o'), wallet_id: 'w2' }]
    expect(localBalances([acct('acc1', 100)], [], items, 'w1')[0]!.currentBalanceMinor).toBe(100)
    expect(mergeLocal([], items, 'w1').map((t) => [t.id, t.sync])).toEqual([['b', 'BLOCKED']])
  })
  it('pending rows show as pending, on top; display owner comes from the outbox user', () => {
    const [p, s] = mergeLocal([srv('s')], [item('p')], 'w1')
    expect(p).toMatchObject({ id: 'p', sync: 'PENDING', created_by: 'A', paid_by_user_id: 'A' })
    expect(s!.id).toBe('s')
  })
  it('pending rows feed the domain totals and category spending', () => {
    const pending = countedPending([], [item('e', expense({ amount_minor: 700 })), item('i', expense({ type: 'income', category_id: null, amount_minor: 900 }))], 'w1')
    const rows = [...pending, srv('s')]
    expect(transactionTotals(rows)).toEqual({ income: 900, expense: 50700, transfer: 0 })
    expect(spendingByCategory(rows).get('cat1')).toBe(50700)
  })
  it('reconcile reports only differences', () => {
    expect(reconcile(new Map([['acc1', 100], ['acc2', 5]]), [acct('acc1', 100), acct('acc2', 6)])).toEqual([{ accountId: 'acc2', expected: 5, server: 6 }])
  })
})

describe('who paid / received by (D7)', () => {
  const upd = (payload: ReturnType<typeof expense>, base: TransactionRow): OutboxItem =>
    ({ ...item(base.id, payload), op: 'UPDATE', expected_version: 1, mutation_id: 'm', base: { ...base, version: 1 } })
  it('a pending create shows the chosen payer, not the creator; created_by stays the creator', () => {
    const [p] = mergeLocal([], [item('p', expense({ paid_by_user_id: 'B' }))], 'w1')
    expect(p).toMatchObject({ created_by: 'A', paid_by_user_id: 'B' })
  })
  it('a pending create without a payer (queued before D7) shows the owner; a transfer has none', () => {
    expect(mergeLocal([], [item('p')], 'w1')[0]!.paid_by_user_id).toBe('A')
    const t = expense({ type: 'transfer', account_id: 'acc1', destination_account_id: 'acc2', category_id: null, paid_by_user_id: 'B' })
    expect(mergeLocal([], [item('t', t)], 'w1')[0]!.paid_by_user_id).toBeNull()
  })
  it('a pending edit overlays the new payer and never touches created_by', () => {
    const [r] = mergeLocal([{ ...srv('s'), version: 1, paid_by_user_id: 'B' }], [upd(expense({ paid_by_user_id: 'C' }), srv('s'))], 'w1')
    expect(r).toMatchObject({ created_by: 'A', paid_by_user_id: 'C' })
  })
  it('a pending edit with no payer keeps the stored one (a former member stays as it was)', () => {
    const [r] = mergeLocal([{ ...srv('s'), version: 1, paid_by_user_id: 'gone' }], [upd(expense(), { ...srv('s'), paid_by_user_id: 'gone' })], 'w1')
    expect(r!.paid_by_user_id).toBe('gone')
  })
  it('payer attribution does not change balances', () => {
    const a = localBalances([acct('acc1', 1000)], [], [item('e', expense({ amount_minor: 300 }))], 'w1')[0]!.currentBalanceMinor
    const b = localBalances([acct('acc1', 1000)], [], [item('e', expense({ amount_minor: 300, paid_by_user_id: 'B' }))], 'w1')[0]!.currentBalanceMinor
    expect(b).toBe(a)
  })
})

