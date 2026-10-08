import { describe, expect, it } from 'vitest'
import { canManage, hasFormerPayer, parseTransaction, resolvePayer, todayLocal } from './transaction'

const ok = { type: 'expense', accountId: 'a', destinationAccountId: '', categoryId: 'c', amount: '500', date: '2026-10-10', note: '' }
const err = (o: Partial<typeof ok>) => {
  const r = parseTransaction({ ...ok, ...o })
  return r.ok ? null : r.error
}

describe('parseTransaction', () => {
  it('stores a positive integer in minor units', () => {
    expect(parseTransaction(ok)).toEqual({
      ok: true,
      value: { type: 'expense', account_id: 'a', destination_account_id: null, category_id: 'c', amount_minor: 50000, date: '2026-10-10', note: null, paid_by_user_id: null },
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
  it('canManage: an anonymized row (creator null) is the owner only', () => {
    expect(canManage(true, { created_by: null }, 'me')).toBe(true)
    expect(canManage(false, { created_by: null }, 'me')).toBe(false)
  })
})

describe('parseTransaction: Who Paid / Received by (D7)', () => {
  const paid = (o: Partial<Parameters<typeof parseTransaction>[0]>) => {
    const r = parseTransaction({ ...ok, ...o })
    return r.ok ? r.value.paid_by_user_id : 'INVALID'
  }
  it('expense and income carry the chosen member; none chosen means null (the server defaults to the creator)', () => {
    expect(paid({ paidByUserId: 'bella' })).toBe('bella')
    expect(paid({ type: 'income', paidByUserId: 'bella' })).toBe('bella')
    expect(paid({})).toBeNull()
    expect(paid({ paidByUserId: '' })).toBeNull()
  })
  it('a transfer never has a payer or recipient, even if one is passed', () => {
    expect(paid({ type: 'transfer', destinationAccountId: 'b', categoryId: '', paidByUserId: 'bella' })).toBeNull()
  })
  it('never emits created_by', () => {
    const r = parseTransaction({ ...ok, paidByUserId: 'bella' })
    expect(r.ok && 'created_by' in r.value).toBe(false)
  })
})

describe('payer of an edited anonymized transaction (D9)', () => {
  /** What the edit form would send, through the real helpers and parser. */
  const sent = (editing: Parameters<typeof hasFormerPayer>[0], selected: string, type = 'expense') => {
    const r = parseTransaction({ ...ok, type, destinationAccountId: type === 'transfer' ? 'b' : '', paidByUserId: resolvePayer(hasFormerPayer(editing), selected, 'me') })
    return r.ok ? r.value.paid_by_user_id : 'INVALID'
  }
  const anonExpense = { type: 'expense' as const, paid_by_user_id: null }
  it('only an income/expense with a null payer counts as a former payer (a transfer has none by design)', () => {
    expect(hasFormerPayer(anonExpense)).toBe(true)
    expect(hasFormerPayer({ type: 'income', paid_by_user_id: null })).toBe(true)
    expect(hasFormerPayer({ type: 'transfer', paid_by_user_id: null })).toBe(false)
    expect(hasFormerPayer({ type: 'expense', paid_by_user_id: 'bella' })).toBe(false)
    expect(hasFormerPayer(null)).toBe(false)
  })
  it('opening and saving without choosing a payer sends no payer, so the server keeps NULL (never the editor)', () => {
    expect(sent(anonExpense, '')).toBeNull()
    expect(sent({ type: 'income', paid_by_user_id: null }, '', 'income')).toBeNull()
  })
  it('explicitly choosing a member sends that member', () => expect(sent(anonExpense, 'bella')).toBe('bella'))
  it('a transfer being converted has no payer yet: the editor is the default; an expense turned into a transfer sends none', () => {
    expect(sent({ type: 'transfer', paid_by_user_id: null }, '')).toBe('me')
    expect(sent(anonExpense, '', 'transfer')).toBeNull()
  })
  it('ordinary rows are unchanged: a new transaction defaults to the user, an edit keeps the chosen/stored payer', () => {
    expect(sent(null, '')).toBe('me')
    expect(sent({ type: 'expense', paid_by_user_id: 'bella' }, 'bella')).toBe('bella')
    expect(sent({ type: 'expense', paid_by_user_id: 'bella' }, '')).toBe('me')
  })
})
