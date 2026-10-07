import { describe, expect, it } from 'vitest'
import type { Account } from '../accounts/account'
import type { Budget } from '../budgets/budget'
import type { Category } from '../categories/category'
import type { DashboardInputs } from '../dashboard/dashboard'
import { projectAccounts, projectDashboard } from './localFinance'
import type { OutboxItem } from './outbox/outbox'
import { localBalances, mergeLocal, reconcile } from './outbox/projection'
import { expense } from './testing'

const M = '2026-10-01'
const acct = (id: string, bal: number) => ({ id, currentBalanceMinor: bal }) as Account
const item = (id: string, payload = expense(), status: OutboxItem['status'] = 'PENDING', wallet_id = 'w1'): OutboxItem =>
  ({ seq: 1, id, user_id: 'A', wallet_id, created_at: '', status, attempt_count: 0, last_error: null, payload, op: 'CREATE', expected_version: null, mutation_id: null, base: null })
const income = (amount_minor: number) => expense({ type: 'income', account_id: 'cash', category_id: null, amount_minor })
const transfer = (amount_minor: number) => expense({ type: 'transfer', account_id: 'bpi', destination_account_id: 'gcash', category_id: null, amount_minor })
const cashExpense = (amount_minor: number, date = '2026-10-05') => expense({ account_id: 'cash', category_id: 'groceries', amount_minor, date })
const cat = (id: string, parentId: string | null = null) => ({ id, walletId: 'w1', parentId, name: id }) as Category
const food: Budget = { id: 'b', walletId: 'w1', categoryId: 'food', month: M, amountMinor: 800000 }
const snap = (over: Partial<DashboardInputs> = {}): DashboardInputs => ({
  month: M, accounts: [acct('cash', 100000)], budgets: [food], categories: [cat('food'), cat('groceries', 'food')], spend: [], confirmed: [], ...over,
})
const bal = (items: OutboxItem[], accounts = [acct('cash', 100000)], confirmed: string[] = []) =>
  projectAccounts({ accounts, confirmed }, items, 'w1').map((a) => a.currentBalanceMinor)

describe('pending-aware balances (server baseline + outbox)', () => {
  it('pending expense: 1000 - 200 = 800', () => expect(bal([item('e', cashExpense(20000))])).toEqual([80000]))
  it('pending income: 1000 + 300 = 1300', () => expect(bal([item('i', income(30000))])).toEqual([130000]))
  it('pending transfer: A 1000 -> 800, B 500 -> 700', () => {
    expect(bal([item('t', transfer(20000))], [acct('bpi', 100000), acct('gcash', 50000)])).toEqual([80000, 70000])
  })
  it('SYNCING and FAILED (retryable) stay in the projection; BLOCKED never does', () => {
    const mk = (status: OutboxItem['status']) => bal([item('x', cashExpense(10000), status)])
    expect(mk('PENDING')).toEqual([90000])
    expect(mk('SYNCING')).toEqual([90000])
    expect(mk('FAILED')).toEqual([90000])
    expect(mk('BLOCKED')).toEqual([100000])
  })
  it('server already has the row (confirmed id): counted once, the server wins', () => {
    const items = [item('e', cashExpense(20000))]
    expect(bal(items, [acct('cash', 80000)], ['e'])).toEqual([80000]) // the baseline already includes it
    expect(bal(items, [acct('cash', 80000)], [])).toEqual([60000]) // without the id it would be counted twice
  })
  it("another wallet's items are ignored", () => {
    expect(bal([item('o', cashExpense(10000), 'PENDING', 'w2')])).toEqual([100000])
  })
  it('empty outbox: baseline unchanged', () => expect(bal([])).toEqual([100000]))
})

describe('dashboard uses the same projection', () => {
  it('Food 8000 budget, server spending 3000 + pending 500 -> spent 3500, remaining 4500; balance 1000 -> 500', () => {
    const s = snap({ spend: [{ id: 's', type: 'expense', amount_minor: 300000, category_id: 'groceries', date: '2026-10-05' }] })
    expect(projectDashboard(s, [item('e', cashExpense(50000))], 'w1')).toMatchObject({ totalBalance: 50000, totalSpent: 350000, totalRemaining: 450000 })
  })
  it('dashboard total equals the sum of the Accounts page balances', () => {
    const accounts = [acct('cash', 100000), acct('bpi', 500000), acct('gcash', 0)]
    const items = [item('e', cashExpense(25000)), item('t', transfer(30000))]
    const page = projectAccounts({ accounts, confirmed: [] }, items, 'w1')
    expect(projectDashboard(snap({ accounts }), items, 'w1').totalBalance).toBe(page.reduce((t, a) => t + a.currentBalanceMinor, 0))
  })
  it('Transactions page balances (localBalances) match Accounts and Dashboard', () => {
    const accounts = [acct('cash', 100000)]
    const items = [item('e', cashExpense(25000))]
    const txPage = localBalances(accounts, [], items, 'w1').map((a) => a.currentBalanceMinor)
    expect(bal(items, accounts)).toEqual(txPage)
    expect(projectDashboard(snap({ accounts }), items, 'w1').totalBalance).toBe(txPage[0])
    expect(mergeLocal([], items, 'w1')).toHaveLength(1) // and the Transactions list shows it
  })
  it('offline transfer leaves the dashboard total unchanged and is not spending', () => {
    const accounts = [acct('bpi', 100000), acct('gcash', 50000)]
    expect(projectDashboard(snap({ accounts }), [item('t', transfer(20000))], 'w1')).toMatchObject({ totalBalance: 150000, totalSpent: 0 })
  })
  it('pending income raises the balance but is not spending', () => {
    expect(projectDashboard(snap(), [item('i', income(30000))], 'w1')).toMatchObject({ totalBalance: 130000, totalSpent: 0 })
  })
  it('BLOCKED expense changes neither balance nor spending', () => {
    expect(projectDashboard(snap(), [item('b', cashExpense(50000), 'BLOCKED')], 'w1')).toMatchObject({ totalBalance: 100000, totalSpent: 0 })
  })
  it('a server spending row with the same id is counted once', () => {
    const s = snap({ spend: [{ id: 'e', type: 'expense', amount_minor: 50000, category_id: 'groceries', date: '2026-10-05' }] })
    expect(projectDashboard(s, [item('e', cashExpense(50000))], 'w1').totalSpent).toBe(50000)
  })
  it("a pending expense from another month is not this month's spending", () => {
    expect(projectDashboard(snap(), [item('e', cashExpense(50000, '2026-09-30'))], 'w1').totalSpent).toBe(0)
  })
})

describe('reconciliation after sync', () => {
  it('server value is authoritative; a difference from the displayed projection is reported, never corrected', () => {
    const shown = new Map(bal([item('e', cashExpense(20000))]).map((b) => ['cash', b]))
    const serverAfterSync = [acct('cash', 75000)] // e.g. a wallet member also spent
    expect(reconcile(shown, serverAfterSync)).toEqual([{ accountId: 'cash', expected: 80000, server: 75000 }])
    expect(serverAfterSync[0]!.currentBalanceMinor).toBe(75000)
    expect(reconcile(shown, [acct('cash', 80000)])).toEqual([])
  })
})

describe('Realtime refresh = a new server baseline under the SAME outbox', () => {
  const mine = [item('mine', cashExpense(50000))] // A's pending offline expense
  it("B's online expense arrives (baseline 1000 -> 900): A's pending 500 is still applied -> 400", () => {
    expect(bal(mine, [acct('cash', 100000)])).toEqual([50000])
    expect(bal(mine, [acct('cash', 90000)])).toEqual([40000])
  })
  it("the same refresh also contains A's own row (it synced meanwhile): counted once, server wins", () => {
    expect(bal(mine, [acct('cash', 40000)], ['mine'])).toEqual([40000])
  })
  it('dashboard and accounts stay consistent after the refresh', () => {
    const s = snap({ accounts: [acct('cash', 90000)], spend: [] })
    const d = projectDashboard(s, mine, 'w1')
    expect(d.totalBalance).toBe(bal(mine, [acct('cash', 90000)])[0])
  })
})
