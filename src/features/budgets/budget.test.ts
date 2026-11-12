import { describe, expect, it } from 'vitest'
import { summarizeBudgets } from '../../domain/finance'
import { budgetFromRow, budgetRows, currentMonth, isMonth, monthLabel, parseBudget, shiftMonth } from './budget'

describe('months', () => {
  it('shifts across year boundaries', () => {
    expect(shiftMonth('2026-12-01', 1)).toBe('2027-01-01')
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01')
    expect(shiftMonth('2026-10-01', 0)).toBe('2026-10-01')
  })
  it('labels', () => expect(monthLabel('2026-10-01')).toBe('October 2026'))
  it('currentMonth is first of the local month', () => expect(currentMonth(new Date(2026, 9, 31, 23, 59))).toBe('2026-10-01'))
  it('isMonth only accepts first-of-month', () => {
    expect(isMonth('2026-10-01')).toBe(true)
    for (const bad of ['2026-10-02', '2026-13-01', '2026-10', '', '2026-00-01']) expect(isMonth(bad)).toBe(false)
  })
})

describe('parseBudget', () => {
  const ok = { categoryId: 'food', month: '2026-10-01', amount: '8000' }
  const top = ['food']
  it('accepts and converts to minor units', () => expect(parseBudget(ok, top)).toEqual({ ok: true, value: { category_id: 'food', month: '2026-10-01', amount_minor: 800000 } }))
  it('rejects zero, negative, junk, fractions of a centavo', () => {
    for (const amount of ['0', '-5', 'abc', '', '1.234']) expect(parseBudget({ ...ok, amount }, top).ok).toBe(false)
  })
  it('rejects a non-top-level category and a bad month', () => {
    expect(parseBudget({ ...ok, categoryId: 'coffee' }, top).ok).toBe(false)
    expect(parseBudget({ ...ok, month: '2026-10-15' }, top).ok).toBe(false)
  })
})

describe('budgetFromRow', () => {
  it('maps columns', () => expect(budgetFromRow({ id: 'i', wallet_id: 'w', category_id: 'c', month: '2026-10-01', amount_minor: 5 })).toEqual({ id: 'i', walletId: 'w', categoryId: 'c', month: '2026-10-01', amountMinor: 5 }))
})

describe('budgetRows', () => {
  const b = (id: string, categoryId: string, amountMinor: number) => ({ id, walletId: 'w', categoryId, month: '2026-11-01', amountMinor })
  it('pairs each budget with its status line, most used first', () => {
    const budgets = [b('b1', 'food', 100000), b('b2', 'bills', 50000), b('b3', 'fun', 20000)]
    const { lines } = summarizeBudgets(budgets, new Map([['food', 85000], ['bills', 10000], ['fun', 25000]]))
    const rows = budgetRows(budgets, lines)
    expect(rows.map((r) => r.budget.id)).toEqual(['b3', 'b1', 'b2']) // 125%, 85%, 20%
    expect(rows.map((r) => r.line.status)).toEqual(['exceeded', 'warning', 'normal'])
    expect(rows[0]!.line.categoryId).toBe(rows[0]!.budget.categoryId)
  })
  it('keeps zero-spend budgets and drops lines with no matching budget', () => {
    const budgets = [b('b1', 'food', 100000)]
    const { lines } = summarizeBudgets(budgets, new Map())
    expect(budgetRows(budgets, lines)).toHaveLength(1)
    expect(budgetRows([], lines)).toEqual([])
  })
})
