import { describe, expect, it } from 'vitest'
import { canManage, parseTransaction, todayLocal } from './transaction'

const ok = { type: 'expense', accountId: 'a', destinationAccountId: '', categoryId: 'c', amount: '500', date: '2026-10-10', note: '' }
const err = (o: Partial<typeof ok>) => {
  const r = parseTransaction({ ...ok, ...o })
  return r.ok ? null : r.error
}

describe('parseTransaction', () => {
  it('stores a positive integer in minor units', () => {
    expect(parseTransaction(ok)).toEqual({
      ok: true,
      value: { type: 'expense', account_id: 'a', destination_account_id: null, category_id: 'c', amount_minor: 50000, date: '2026-10-10', note: null },
    })
  })
  it('income drops any category', () =>
    expect(parseTransaction({ ...ok, type: 'income' })).toMatchObject({ ok: true, value: { category_id: null } }))
  it('rejects zero, negative, junk and sub-centavo amounts', () => {
    for (const amount of ['0', '-5', 'abc', '1.234', '']) expect(err({ amount })).toMatch(/amount/i)
  })
  it('expense needs a category; account and date are required', () => {
    expect(err({ categoryId: '' })).toMatch(/category/)
    expect(err({ accountId: '' })).toMatch(/account/)
    for (const date of ['', '2026-02-30', '10/10/2026']) expect(err({ date })).toMatch(/date/)
  })
  it('transfer: two different accounts, no category', () => {
    const t = { type: 'transfer', destinationAccountId: 'b', categoryId: 'c' }
    expect(parseTransaction({ ...ok, ...t })).toMatchObject({
      ok: true, value: { type: 'transfer', account_id: 'a', destination_account_id: 'b', category_id: null, amount_minor: 50000 },
    })
    expect(err({ ...t, destinationAccountId: '' })).toMatch(/transfer to/)
    expect(err({ ...t, accountId: '' })).toMatch(/transfer from/)
    expect(err({ ...t, destinationAccountId: 'a' })).toMatch(/different/)
    for (const amount of ['0', '-5', 'abc']) expect(err({ ...t, amount })).toMatch(/amount/i)
  })
  it('income/expense never send a destination', () =>
    expect(parseTransaction({ ...ok, destinationAccountId: 'b' })).toMatchObject({ value: { destination_account_id: null } }))
  it('rejects unknown types and long notes', () => {
    expect(err({ type: 'refund' })).toMatch(/income, expense or transfer/)
    expect(err({ note: 'x'.repeat(501) })).toMatch(/Note/)
  })
})

describe('helpers', () => {
  it('todayLocal is the local calendar day', () => expect(todayLocal(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05'))
  it('canManage: owner all, member own only', () => {
    expect(canManage(true, { created_by: 'x' }, 'me')).toBe(true)
    expect(canManage(false, { created_by: 'me' }, 'me')).toBe(true)
    expect(canManage(false, { created_by: 'x' }, 'me')).toBe(false)
  })
})
