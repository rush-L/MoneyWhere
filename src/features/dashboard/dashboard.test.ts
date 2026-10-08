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
    expect(summarizeBudgets([], new Map())).toEqual({ totalBudgeted: 0, totalSpent: 0, budgetedSpent: 0, totalRemaining: 0, lines: [] })
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

describe('dashboard metrics: Total Spent vs Budgeted Spent vs Monthly Income', () => {
  const base = { month: M, categories: cats, accounts: [] as Account[], budgets: [bud('food', 800000)] }
  const inc = (amount_minor: number, date = '2026-10-05') => ({ id: `i${n++}`, type: 'income' as const, amount_minor, category_id: null, date })
  const xfer = (amount_minor: number, date = '2026-10-05') => ({ id: `t${n++}`, type: 'transfer' as const, amount_minor, category_id: null, date })
  const metrics = (d: ReturnType<typeof buildDashboard>) => ({ spent: d.totalSpent, budgeted: d.budgetedSpent, income: d.monthlyIncome })

  it('required scenario: 5,000 budgeted + 2,000 unbudgeted expense, 20,000 income, 3,000 transfer', () => {
    const d = buildDashboard({ ...base, spend: [exp('groceries', 500000), exp('bills', 200000), xfer(300000)], income: [inc(2000000)] })
    expect(metrics(d)).toEqual({ spent: 700000, budgeted: 500000, income: 2000000 })
  })
  it('case 1: only budgeted expenses', () => {
    expect(metrics(buildDashboard({ ...base, spend: [exp('groceries', 500000)] }))).toEqual({ spent: 500000, budgeted: 500000, income: 0 })
  })
  it('case 2: only unbudgeted expenses', () => {
    expect(metrics(buildDashboard({ ...base, spend: [exp('bills', 500000)] }))).toEqual({ spent: 500000, budgeted: 0, income: 0 })
  })
  it('case 3: no expenses', () => {
    expect(metrics(buildDashboard({ ...base, spend: [] }))).toEqual({ spent: 0, budgeted: 0, income: 0 })
  })
  it('case 4: income only counts as income, never as spending', () => {
    expect(metrics(buildDashboard({ ...base, spend: [], income: [inc(1500000), inc(250000)] }))).toEqual({ spent: 0, budgeted: 0, income: 1750000 })
  })
  it('case 5: transfers only count as neither spending nor income', () => {
    expect(metrics(buildDashboard({ ...base, spend: [xfer(300000)], income: [xfer(100000)] }))).toEqual({ spent: 0, budgeted: 0, income: 0 })
  })
  it('case 6: mixed month, other months excluded, subcategories roll up to their budget', () => {
    const d = buildDashboard({
      ...base,
      budgets: [bud('food', 800000), bud('transport', 300000)],
      spend: [
        exp('groceries', 300000), exp('coffee', 50000), // food (via subcategories): 3,500
        exp('transport', 100000), // budgeted: 1,000
        exp('bills', 70000), // unbudgeted: 700
        exp('food', 999, '2026-09-30'), exp('bills', 999, '2026-11-01'), // other months
        xfer(400000),
      ],
      income: [inc(3000000), inc(500000), inc(999, '2026-09-30')],
    })
    expect(metrics(d)).toEqual({ spent: 520000, budgeted: 450000, income: 3500000 })
    expect(d.totalBudgeted).toBe(1100000)
  })
  it('Budgeted Spent never exceeds Total Spent and the unbudgeted part is the difference', () => {
    const d = buildDashboard({ ...base, spend: [exp('groceries', 123456), exp('bills', 7890)] })
    expect(d.totalSpent - d.budgetedSpent).toBe(7890)
  })
  it('a snapshot cached before income existed still builds (income 0 until it revalidates)', () => {
    expect(buildDashboard({ ...base, spend: [exp('groceries', 100)] }).monthlyIncome).toBe(0)
  })
  it('Needs Attention keeps using the D2 thresholds', () => {
    const d = buildDashboard({ ...base, budgets: [bud('food', 1000)], spend: [exp('food', 800)] })
    expect(d.attention[0]).toMatchObject({ status: 'warning', over: false })
    expect(buildDashboard({ ...base, budgets: [bud('food', 1000)], spend: [exp('food', 1000)] }).attention[0]).toMatchObject({ status: 'exceeded', over: true })
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
    budgets: { list: async () => [bud('food', 1000)], spending: over.spend ?? (async () => []), income: over.income ?? (async () => []) },
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
  it('a failed income read fails the whole load (no partial totals)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failing = deps({ income: async () => { throw new Error('boom') } })
    await expect(createDashboardService(failing as never).load('w', M)).rejects.toThrow("We couldn't load your financial summary")
  })
})
