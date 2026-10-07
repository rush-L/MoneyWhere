import { describe, expect, it } from 'vitest'
import { accountBalance, spendingByCategory, transactionTotals, formatMinor, parseMinor, type Transaction } from './index'

const A = 'acc-a'
const B = 'acc-b'
let n = 0
const tx = (p: Partial<Transaction> & Pick<Transaction, 'type' | 'amount_minor'>): Transaction => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  account_id: A, destination_account_id: null, category_id: null, date: '2026-01-01', ...p,
})
const P = (pesos: number) => Math.round(pesos * 100)

describe('accountBalance', () => {
  it('opening only', () => expect(accountBalance(A, P(10000), [])).toBe(P(10000)))
  it('income', () => expect(accountBalance(A, P(10000), [tx({ type: 'income', amount_minor: P(5000) })])).toBe(P(15000)))
  it('expense', () => expect(accountBalance(A, P(10000), [tx({ type: 'expense', amount_minor: P(2000) })])).toBe(P(8000)))
  it('transfer out', () =>
    expect(accountBalance(A, P(10000), [tx({ type: 'transfer', amount_minor: P(3000), destination_account_id: B })])).toBe(P(7000)))
  it('transfer in', () =>
    expect(accountBalance(A, P(10000), [tx({ type: 'transfer', amount_minor: P(3000), account_id: B, destination_account_id: A })])).toBe(P(13000)))
  it('mixed', () => {
    const txs = [
      tx({ type: 'income', amount_minor: P(5000) }),
      tx({ type: 'expense', amount_minor: 125050 }),
      tx({ type: 'transfer', amount_minor: P(3000), destination_account_id: B }),
      tx({ type: 'transfer', amount_minor: P(500), account_id: B, destination_account_id: A }),
    ]
    expect(accountBalance(A, P(10000), txs)).toBe(1_000_000 + 500_000 - 125_050 - 300_000 + 50_000)
  })
  it('ignores other accounts', () =>
    expect(accountBalance(A, 100, [tx({ type: 'expense', amount_minor: 50, account_id: B })])).toBe(100))
  it('zero values', () => {
    expect(accountBalance(A, 0, [])).toBe(0)
    expect(accountBalance(A, 0, [tx({ type: 'income', amount_minor: 0 })])).toBe(0)
  })
  it('large values stay exact', () => {
    const big = P(1_000_000_000)
    expect(accountBalance(A, big, [tx({ type: 'income', amount_minor: 1 })])).toBe(big + 1)
  })
  it('rejects non-integer or unsafe amounts', () => {
    expect(() => accountBalance(A, 0.5, [])).toThrow()
    expect(() =>
      accountBalance(A, 0, [tx({ type: 'income', amount_minor: Number.MAX_SAFE_INTEGER }), tx({ type: 'income', amount_minor: 1 })]),
    ).toThrow()
  })
})

describe('two-account transfer', () => {
  const t = tx({ type: 'transfer', amount_minor: P(3000), account_id: A, destination_account_id: B })
  it('source decreases, destination increases, total money unchanged', () => {
    const [a0, b0] = [P(20000), P(5000)]
    const [a1, b1] = [accountBalance(A, a0, [t]), accountBalance(B, b0, [t])]
    expect([a1, b1]).toEqual([P(17000), P(8000)])
    expect(a0 - a1).toBe(b1 - b0)
    expect(a1 + b1).toBe(a0 + b0)
  })
  it('is not income, expense or category spending', () => {
    expect(transactionTotals([t])).toEqual({ income: 0, expense: 0, transfer: P(3000) })
    expect(spendingByCategory([t]).size).toBe(0)
  })
})

describe('transactionTotals', () => {
  it('keeps transfers out of expense', () => {
    expect(
      transactionTotals([
        tx({ type: 'income', amount_minor: 500 }),
        tx({ type: 'expense', amount_minor: 200 }),
        tx({ type: 'transfer', amount_minor: 300, destination_account_id: B }),
      ]),
    ).toEqual({ income: 500, expense: 200, transfer: 300 })
  })
  it('empty', () => expect(transactionTotals([])).toEqual({ income: 0, expense: 0, transfer: 0 }))
})

describe('spendingByCategory', () => {
  it('sums expenses per category; ignores income and uncategorised', () => {
    const m = spendingByCategory([
      tx({ type: 'expense', amount_minor: 100, category_id: 'food' }),
      tx({ type: 'expense', amount_minor: 250, category_id: 'food' }),
      tx({ type: 'expense', amount_minor: 40, category_id: 'fuel' }),
      tx({ type: 'income', amount_minor: 9999 }),
    ])
    expect([...m]).toEqual([['food', 350], ['fuel', 40]])
  })
})

describe('money parse/format', () => {
  it('round-trips', () => {
    expect(parseMinor('100.50')).toBe(10050)
    expect(parseMinor('100.5')).toBe(10050)
    expect(parseMinor('7')).toBe(700)
    expect(parseMinor('-0.05')).toBe(-5)
    expect(formatMinor(10050)).toBe('100.50')
    expect(formatMinor(-5)).toBe('-0.05')
  })
  it('rejects bad input', () => {
    expect(() => parseMinor('1.234')).toThrow()
    expect(() => parseMinor('abc')).toThrow()
  })
})
