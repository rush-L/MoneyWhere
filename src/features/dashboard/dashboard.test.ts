import { describe, expect, it, vi } from 'vitest'
import { summarizeBudgets } from '../../domain/finance'
import type { Account } from '../accounts/account'
import type { Budget } from '../budgets/budget'
import { currentMonth } from '../budgets/budget'
import type { Category } from '../categories/category'
import type { Wallet } from '../wallets/wallet'
import { buildDashboard, pickWallet } from './dashboard'
import { createDashboardService } from './dashboardService'

const M = '2026-10-01'
const cat = (id: string, parentId: string | null = null): Category => ({ id, walletId: 'w', parentId, name: id })
const cats = [cat('food'), cat('groceries', 'food'), cat('coffee', 'food'), cat('transport'), cat('bills')]
const bud = (categoryId: string, amountMinor: number): Budget => ({ id: categoryId, walletId: 'w', categoryId, month: M, amountMinor })
let n = 0
const exp = (category_id: string, amount_minor: number, date = '2026-10-05') => ({ id: `s${n++}`, type: 'expense' as const, amount_minor, category_id, date })
const acct = (currentBalanceMinor: number) => ({ currentBalanceMinor }) as Account
const wallet = (id: string) => ({ id }) as Wallet

describe('summarizeBudgets', () => {
  it('zero budgets and zero spending', () => {
    expect(summarizeBudgets([], new Map())).toEqual({ totalBudgeted: 0, totalSpent: 0, totalRemaining: 0, lines: [] })
  })
  it('exact budget is exceeded', () => {
    const s = summarizeBudgets([{ categoryId: 'a', amountMinor: 100 }], new Map([['a', 100]]))
    expect(s.totalRemaining).toBe(0)
    expect(s.lines[0]).toMatchObject({ over: true, percentUsed: 100 })
  })
  it('over budget gives negative remaining', () => {
    expect(summarizeBudgets([{ categoryId: 'a', amountMinor: 1600000 }], new Map([['a', 1800000]])).totalRemaining).toBe(-200000)
  })
  it('ranks over-budget first, then by percent used; ties are deterministic', () => {
    const budgets = ['a', 'b', 'c', 'd', 'e'].map((categoryId) => ({ categoryId, amountMinor: 1000 }))
    const spent = new Map([['a', 840], ['b', 1062], ['c', 950], ['d', 0], ['e', 950]])
    expect(summarizeBudgets(budgets, spent).lines.map((l) => l.categoryId)).toEqual(['b', 'c', 'e', 'a', 'd'])
  })
})

describe('buildDashboard', () => {
  const base = { month: M, categories: cats }
  it('Food 8000 budget, Groceries 3000 + Coffee 500 → 3500 spent, 4500 remaining; balances summed', () => {
    const d = buildDashboard({ ...base, accounts: [acct(500000), acct(-20000)], budgets: [bud('food', 800000)], spend: [exp('groceries', 300000), exp('coffee', 50000)] })
    expect(d).toMatchObject({ totalBalance: 480000, totalBudgeted: 800000, totalSpent: 350000, totalRemaining: 450000, budgetCount: 1 })
    expect(d.attention[0]).toMatchObject({ name: 'food', spent: 350000, over: false })
  })
  it('ignores income, transfers and other months; unbudgeted expenses still count as spent', () => {
    const spend = [
      exp('food', 100),
      exp('bills', 50), // no budget for bills
      exp('food', 999, '2026-09-30'),
      exp('food', 999, '2026-11-01'),
      { id: 'i', type: 'income' as const, amount_minor: 5000, category_id: 'food', date: '2026-10-05' },
      { id: 't', type: 'transfer' as const, amount_minor: 5000, category_id: null, date: '2026-10-05' },
    ]
    const d = buildDashboard({ ...base, accounts: [], budgets: [bud('food', 1000)], spend })
    expect(d.totalSpent).toBe(150)
  })
  it('no budgets, no transactions: zeros and an empty attention list', () => {
    expect(buildDashboard({ ...base, accounts: [], budgets: [], spend: [] })).toMatchObject({ accountCount: 0, totalBalance: 0, totalSpent: 0, budgetCount: 0, attention: [] })
  })
  it('shows only the top three', () => {
    const budgets = ['food', 'transport', 'bills', 'groceries'].map((c) => bud(c, 1000))
    expect(buildDashboard({ ...base, accounts: [], budgets, spend: [exp('transport', 500)] }).attention).toHaveLength(3)
  })
})

describe('current month and wallet selection', () => {
  it('month is the local calendar month, first day, regardless of time of day', () => {
    expect(currentMonth(new Date(2026, 9, 1, 0, 0))).toBe('2026-10-01')
    expect(currentMonth(new Date(2026, 9, 31, 23, 59))).toBe('2026-10-01')
  })
  it('picks the saved wallet, else the first, else null', () => {
    const ws = [wallet('a'), wallet('b')]
    expect(pickWallet(ws, 'b')?.id).toBe('b')
    expect(pickWallet(ws, 'gone')?.id).toBe('a')
    expect(pickWallet(ws, null)?.id).toBe('a')
    expect(pickWallet([], 'a')).toBeNull()
  })
})

describe('dashboard service', () => {
  const deps = (over: Partial<Record<string, () => Promise<never[]>>> = {}) => ({
    transactions: { existingIds: over.tx ?? (async () => []) },
    categories: { list: async () => cats },
    budgets: { list: async () => [bud('food', 1000)], spending: over.spend ?? (async () => []) },
    accounts: { list: async () => [acct(100)] },
  })
  it('maps loaded data', async () => {
    const d = await createDashboardService(deps() as never).load('w', M)
    expect(buildDashboard(d)).toMatchObject({ totalBalance: 100, totalBudgeted: 1000, totalSpent: 0, totalRemaining: 1000 })
  })
  it('turns any failure into a safe message with no raw error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = deps({ spend: async () => { throw new Error('PGRST301 secret detail') } })
    await expect(createDashboardService(failing as never).load('w', M)).rejects.toThrow("We couldn't load your financial summary. Please try again.")
  })
})
