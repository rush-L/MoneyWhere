import { describe, expect, it } from 'vitest'
import type { TransactionRow } from './transaction'
import { applyFilters, EMPTY_FILTERS, hasFilters, matchesSearch, type FilterLookup, type TxFilters } from './transactionFilter'

const ME = 'me'
const BELLA = 'bella'
const GONE = 'gone'
const accounts: Record<string, string> = { a1: 'Cash Wallet', a2: 'BDO Savings', a3: 'GCash' }
const cats: Record<string, { name: string; parent: string | null }> = {
  food: { name: 'Food', parent: null },
  groc: { name: 'Groceries', parent: 'Food' },
  pay: { name: 'Salary', parent: null },
}
const names: Record<string, string> = { [ME]: 'You', [BELLA]: 'Bella' }
const lk: FilterLookup = {
  accountName: (id) => accounts[id] ?? 'Unknown account',
  categoryName: (id) => cats[id]?.name ?? 'Unknown category',
  parentCategoryName: (id) => cats[id]?.parent ?? null,
  payerLabel: (id) => (id === null ? 'Former member' : (names[id] ?? 'Former member')),
}
const f = (o: Partial<TxFilters>): TxFilters => ({ ...EMPTY_FILTERS, ...o })

const row = (o: Partial<TransactionRow> & { id: string }): TransactionRow => ({
  account_id: 'a1', destination_account_id: null, category_id: null, type: 'expense', amount_minor: 100, date: '2026-10-10',
  note: null, created_by: ME, paid_by_user_id: ME, version: 1, ...o,
})
const rent = row({ id: 'rent', note: 'October RENT', category_id: 'food', date: '2026-10-01' })
const shop = row({ id: 'shop', note: 'weekly shop', category_id: 'groc', paid_by_user_id: BELLA, account_id: 'a2', date: '2026-10-15' })
const pay = row({ id: 'pay', type: 'income', category_id: null, account_id: 'a2', date: '2026-10-31', paid_by_user_id: ME })
const old = row({ id: 'old', paid_by_user_id: GONE, date: '2026-09-30' })
const xfer = row({ id: 'xfer', type: 'transfer', account_id: 'a1', destination_account_id: 'a3', paid_by_user_id: null, date: '2026-10-15' })
const pending = { ...row({ id: 'pend', note: 'offline lunch', paid_by_user_id: ME }), sync: 'PENDING' as const }
const all = [rent, shop, pay, old, xfer]
const ids = (r: readonly { id: string }[]) => r.map((x) => x.id)

describe('search', () => {
  it('matches note, case-insensitively and as a substring', () => {
    expect(matchesSearch(rent, 'rent', lk)).toBe(true)
    expect(matchesSearch(rent, 'OCTOB', lk)).toBe(true)
    expect(matchesSearch(rent, 'xyz', lk)).toBe(false)
  })
  it('matches account, category, parent category, payer and type', () => {
    expect(matchesSearch(shop, 'bdo', lk)).toBe(true)
    expect(matchesSearch(shop, 'grocer', lk)).toBe(true)
    expect(matchesSearch(shop, 'food', lk)).toBe(true) // parent of Groceries
    expect(matchesSearch(rent, 'groc', lk)).toBe(false) // a parent does not match its child's name
    expect(matchesSearch(shop, 'bella', lk)).toBe(true)
    expect(matchesSearch(pay, 'income', lk)).toBe(true)
    expect(matchesSearch(rent, 'income', lk)).toBe(false)
  })
  it('matches both accounts of a transfer and "transfer", but never a payer or an id', () => {
    expect(matchesSearch(xfer, 'cash', lk)).toBe(true)
    expect(matchesSearch(xfer, 'gcash', lk)).toBe(true)
    expect(matchesSearch(xfer, 'transfer', lk)).toBe(true)
    expect(matchesSearch(xfer, 'former', lk)).toBe(false)
    expect(matchesSearch(rent, 'rent', { ...lk, accountName: () => 'x' })).toBe(true)
    expect(matchesSearch(shop, 'bella', { ...lk, payerLabel: () => 'x' })).toBe(false) // the payer id is not searchable, only its label
  })
  it('a blank search matches everything', () => {
    expect(matchesSearch(rent, '   ', lk)).toBe(true)
  })
})

describe('dates (inclusive, string compare on the stored date)', () => {
  it('single day, from only, to only, range, boundaries', () => {
    expect(ids(applyFilters(all, f({ from: '2026-10-15', to: '2026-10-15' }), lk))).toEqual(['shop', 'xfer'])
    expect(ids(applyFilters(all, f({ from: '2026-10-15' }), lk))).toEqual(['shop', 'pay', 'xfer'])
    expect(ids(applyFilters(all, f({ to: '2026-10-01' }), lk))).toEqual(['rent', 'old'])
    expect(ids(applyFilters(all, f({ from: '2026-10-01', to: '2026-10-31' }), lk))).toEqual(['rent', 'shop', 'pay', 'xfer'])
  })
  it('from after to matches nothing', () => {
    expect(applyFilters(all, f({ from: '2026-10-20', to: '2026-10-10' }), lk)).toEqual([])
  })
})

describe('category, payer, type', () => {
  it('category is exact and multi-select is OR; transfers have no category', () => {
    expect(ids(applyFilters(all, f({ categoryIds: ['groc'] }), lk))).toEqual(['shop'])
    expect(ids(applyFilters(all, f({ categoryIds: ['groc', 'food'] }), lk))).toEqual(['rent', 'shop'])
  })
  it('payer: current member, former member; transfers (no payer) never match', () => {
    expect(ids(applyFilters(all, f({ payerIds: [BELLA] }), lk))).toEqual(['shop'])
    expect(ids(applyFilters(all, f({ payerIds: [GONE] }), lk))).toEqual(['old'])
    expect(ids(applyFilters(all, f({ payerIds: [ME, BELLA] }), lk))).toEqual(['rent', 'shop', 'pay'])
  })
  it('type multi-select is OR', () => {
    expect(ids(applyFilters(all, f({ types: ['income', 'transfer'] }), lk))).toEqual(['pay', 'xfer'])
  })
})

describe('accounts', () => {
  it('normal rows match their account; transfers match source or destination only', () => {
    expect(ids(applyFilters(all, f({ accountIds: ['a2'] }), lk))).toEqual(['shop', 'pay'])
    expect(ids(applyFilters([xfer], f({ accountIds: ['a1'] }), lk))).toEqual(['xfer']) // source
    expect(ids(applyFilters([xfer], f({ accountIds: ['a3'] }), lk))).toEqual(['xfer']) // destination
    expect(applyFilters([xfer], f({ accountIds: ['a2'] }), lk)).toEqual([]) // neither
  })
})

describe('combination', () => {
  it('AND between filters, OR within one, search ANDed on top', () => {
    expect(ids(applyFilters(all, f({ accountIds: ['a1', 'a2'], types: ['expense'] }), lk))).toEqual(['rent', 'shop', 'old'])
    expect(ids(applyFilters(all, f({ accountIds: ['a1', 'a2'], types: ['expense'], search: 'shop' }), lk))).toEqual(['shop'])
    expect(applyFilters(all, f({ types: ['income'], search: 'rent' }), lk)).toEqual([])
  })
  it('preserves order and does not mutate the input', () => {
    const copy = [...all]
    applyFilters(all, f({ types: ['expense'] }), lk)
    expect(all).toEqual(copy)
  })
})

describe('offline labels and pending rows', () => {
  const offline: FilterLookup = { ...lk, payerLabel: (id) => (id === ME ? 'You' : id === null ? 'Former member' : 'Another member') }
  it('searches the displayed label: "You" and "Another member"', () => {
    expect(matchesSearch(rent, 'you', offline)).toBe(true)
    expect(matchesSearch(shop, 'another', offline)).toBe(true)
    expect(matchesSearch(shop, 'bella', offline)).toBe(false)
  })
  it('a pending offline row is searched and filtered like any other', () => {
    const rows = [pending, ...all]
    expect(ids(applyFilters(rows, f({ search: 'lunch' }), offline))).toEqual(['pend'])
    expect(ids(applyFilters(rows, f({ payerIds: [ME], accountIds: ['a1'], from: '2026-10-10', to: '2026-10-10' }), offline))).toEqual(['pend'])
  })
})

describe('empty results', () => {
  it('hasFilters tells "no matches" from "no filters", so the page can keep the two empty states apart', () => {
    expect(hasFilters(EMPTY_FILTERS)).toBe(false)
    expect(hasFilters(f({ search: ' ' }))).toBe(false)
    expect(hasFilters(f({ search: 'zzz' }))).toBe(true)
    expect(applyFilters(all, f({ search: 'zzz' }), lk)).toEqual([])
    expect(applyFilters([], EMPTY_FILTERS, lk)).toEqual([])
    expect(ids(applyFilters(all, EMPTY_FILTERS, lk))).toEqual(ids(all))
  })
})
