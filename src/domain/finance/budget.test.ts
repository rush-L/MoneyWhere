import { describe, expect, it } from 'vitest'
import { calculateBudgetStatus, spendingByBudgetCategory, type Transaction } from './index'

const P = (pesos: number) => pesos * 100
const OCT = '2026-10-01'
const cats = [
  { id: 'food', parentId: null }, { id: 'groc', parentId: 'food' }, { id: 'coffee', parentId: 'food' }, { id: 'rest', parentId: 'food' },
  { id: 'transport', parentId: null },
]
const tx = (type: Transaction['type'], category_id: string | null, pesos: number, date = '2026-10-15') =>
  ({ type, category_id, amount_minor: P(pesos), date })

describe('calculateBudgetStatus', () => {
  it('remaining', () => expect(calculateBudgetStatus(P(8000), P(5000))).toMatchObject({ remaining: P(3000), percentUsed: 62.5, over: false }))
  it('exact limit is exceeded', () => expect(calculateBudgetStatus(P(8000), P(8000))).toMatchObject({ remaining: 0, percentUsed: 100, status: 'exceeded', over: true }))
  it('over budget', () => expect(calculateBudgetStatus(P(8000), P(9000))).toMatchObject({ remaining: -P(1000), percentUsed: 112.5, over: true }))
  it.each([
    ['0%', 0, 'normal'],
    ['79%', 7900, 'normal'],
    ['just under 80% (79.99%)', 7999, 'normal'],
    ['exactly 80%', 8000, 'warning'],
    ['99%', 9900, 'warning'],
    ['just under 100% (99.99%)', 9999, 'warning'],
    ['exactly 100%', 10000, 'exceeded'],
    ['over 100%', 10001, 'exceeded'],
  ] as const)('threshold at %s', (_n, spent, status) => {
    const s = calculateBudgetStatus(10000, spent)
    expect(s.status).toBe(status)
    expect(s.over).toBe(status === 'exceeded')
  })
  it('boundaries are exact for budgets that do not divide evenly', () => {
    expect(calculateBudgetStatus(3, 2).status).toBe('normal') // 66.7%
    expect(calculateBudgetStatus(5, 4).status).toBe('warning') // exactly 80%
    expect(calculateBudgetStatus(9007199254740991, 9007199254740990).status).toBe('warning')
    expect(calculateBudgetStatus(9007199254740991, 9007199254740991).status).toBe('exceeded')
  })
  it('unrounded percentage', () => expect(calculateBudgetStatus(P(8000), P(5500)).percentUsed).toBe(68.75))
  it('rejects non-positive budget', () => expect(() => calculateBudgetStatus(0, 0)).toThrow())
})

describe('spendingByBudgetCategory', () => {
  const food = (txs: ReturnType<typeof tx>[]) => spendingByBudgetCategory(txs, cats, OCT).get('food')
  it('subcategories roll up to the top-level category', () => expect(food([tx('expense', 'groc', 3000), tx('expense', 'coffee', 500)])).toBe(P(3500)))
  it('multiple subcategories count exactly once each', () =>
    expect(food([tx('expense', 'groc', 3000), tx('expense', 'coffee', 500), tx('expense', 'rest', 2000)])).toBe(P(5500)))
  it('direct top-level expense counts', () => expect(food([tx('expense', 'food', 700)])).toBe(P(700)))
  it('direct + subcategory together, no double count', () => expect(food([tx('expense', 'food', 700), tx('expense', 'groc', 300)])).toBe(P(1000)))
  it('transfers excluded', () => expect(food([tx('transfer', null, 999), tx('expense', 'groc', 100)])).toBe(P(100)))
  it('income excluded', () => expect(food([tx('income', 'groc', 999), tx('expense', 'groc', 100)])).toBe(P(100)))
  it('other months excluded (incl. adjacent boundaries)', () =>
    expect(food([tx('expense', 'groc', 1, '2026-09-30'), tx('expense', 'groc', 1, '2026-11-01'), tx('expense', 'groc', 1, '2026-10-01'), tx('expense', 'groc', 1, '2026-10-31')])).toBe(P(2)))
  it('other top-level categories are separate buckets', () => {
    const m = spendingByBudgetCategory([tx('expense', 'groc', 10), tx('expense', 'transport', 20)], cats, OCT)
    expect([m.get('food'), m.get('transport')]).toEqual([P(10), P(20)])
  })
  it('unknown category ignored', () => expect(spendingByBudgetCategory([tx('expense', 'zzz', 5)], cats, OCT).size).toBe(0))
})
