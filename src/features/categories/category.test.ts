import { describe, expect, it } from 'vitest'
import { categoryCounts, categoryFromRow, countLine, groupCategories, parseCategoryName, pendingDeleteBlock, PENDING_DELETE_MESSAGE, type Category } from './category'

describe('categoryFromRow', () => {
  it('maps snake_case columns and keeps a null parent', () => {
    expect(categoryFromRow({ id: 'c', wallet_id: 'w', parent_id: null, name: 'Food' })).toEqual({ id: 'c', walletId: 'w', parentId: null, name: 'Food' })
    expect(categoryFromRow({ id: 'c', wallet_id: 'w', parent_id: 'p', name: 'Coffee' })).toMatchObject({ parentId: 'p' })
  })
})

describe('parseCategoryName', () => {
  it('trims', () => expect(parseCategoryName('  Pets ')).toEqual({ ok: true, name: 'Pets' }))
  it('rejects empty and whitespace-only', () => {
    expect(parseCategoryName('').ok).toBe(false)
    expect(parseCategoryName('   ').ok).toBe(false)
  })
  it('allows 50 characters, rejects 51', () => {
    expect(parseCategoryName('x'.repeat(50)).ok).toBe(true)
    expect(parseCategoryName('x'.repeat(51)).ok).toBe(false)
  })
})

describe('groupCategories', () => {
  const c = (id: string, name: string, parentId: string | null = null) => ({ id, walletId: 'w', parentId, name })
  it('nests children under parents, each sorted by name', () => {
    const g = groupCategories([c('2', 'Food'), c('3', 'Coffee', '2'), c('1', 'Bills'), c('4', 'Groceries', '2')])
    expect(g.map((x) => x.category.name)).toEqual(['Bills', 'Food'])
    expect(g[1]!.children.map((x) => x.name)).toEqual(['Coffee', 'Groceries'])
    expect(g[0]!.children).toEqual([])
  })
})

const cat = (id: string, name: string, parentId: string | null = null): Category => ({ id, walletId: 'w', parentId, name })
const DEFAULTS = [
  cat('food', 'Food'), cat('g', 'Groceries', 'food'), cat('r', 'Restaurants', 'food'), cat('c', 'Coffee', 'food'),
  cat('tr', 'Transportation'), cat('f', 'Fuel', 'tr'), cat('p', 'Public Transportation', 'tr'), cat('s', 'Ride Sharing', 'tr'),
  cat('bills', 'Bills'), cat('e', 'Electricity', 'bills'), cat('w', 'Water', 'bills'), cat('i', 'Internet', 'bills'), cat('ph', 'Phone', 'bills'),
  cat('life', 'Lifestyle'), cat('en', 'Entertainment', 'life'), cat('sh', 'Shopping', 'life'), cat('h', 'Hobbies', 'life'),
]

describe('categoryCounts / countLine', () => {
  it('counts the starter set as 4 categories and 13 subcategories', () => {
    expect(categoryCounts(DEFAULTS)).toEqual({ categories: 4, subcategories: 13 })
    expect(countLine(categoryCounts(DEFAULTS))).toBe('4 categories · 13 subcategories')
  })
  it('handles none, one of each, and top-level only', () => {
    expect(countLine(categoryCounts([]))).toBe('0 categories · 0 subcategories')
    expect(countLine(categoryCounts([cat('a', 'A'), cat('b', 'B', 'a')]))).toBe('1 category · 1 subcategory')
    expect(categoryCounts([cat('a', 'A'), cat('b', 'B')])).toEqual({ categories: 2, subcategories: 0 })
  })
  it('the groups agree with the counts and keep every category exactly once', () => {
    const groups = groupCategories(DEFAULTS)
    const counts = categoryCounts(DEFAULTS)
    expect(groups).toHaveLength(counts.categories)
    expect(groups.reduce((n, g) => n + g.children.length, 0)).toBe(counts.subcategories)
    expect(groups.map((g) => g.category.name)).toEqual(['Bills', 'Food', 'Lifestyle', 'Transportation']) // name order, as before
    expect(groups.find((g) => g.category.id === 'food')!.children.map((c) => c.name)).toEqual(['Coffee', 'Groceries', 'Restaurants'])
  })
})

describe('pendingDeleteBlock', () => {
  const food = DEFAULTS[0]!
  const coffee = DEFAULTS[3]!
  it('is clear when nothing is pending', () => expect(pendingDeleteBlock(food, DEFAULTS, new Set())).toBeNull())
  it('blocks a category a pending expense uses directly', () => expect(pendingDeleteBlock(food, DEFAULTS, new Set(['food']))).toBe('self'))
  it('blocks a subcategory a pending expense uses', () => expect(pendingDeleteBlock(coffee, DEFAULTS, new Set(['c']))).toBe('self'))
  it('blocks a parent when a pending expense uses one of the subcategories deleting it would also delete', () => {
    expect(pendingDeleteBlock(food, DEFAULTS, new Set(['c']))).toBe('subcategory')
  })
  it('prefers "self" when both the parent and a child are in use', () => expect(pendingDeleteBlock(food, DEFAULTS, new Set(['food', 'c']))).toBe('self'))
  it('does not block on unrelated categories, or on a sibling or the parent when deleting a subcategory', () => {
    expect(pendingDeleteBlock(food, DEFAULTS, new Set(['tr', 'f', 'bills']))).toBeNull()
    expect(pendingDeleteBlock(coffee, DEFAULTS, new Set(['food', 'g']))).toBeNull() // the parent stays; a sibling is untouched
  })
  it('explains each case, and never promises the delete will work', () => {
    expect(PENDING_DELETE_MESSAGE.self).toBe("This category is used by a transaction that hasn't synced yet. Sync or discard the pending transaction before deleting this category.")
    expect(PENDING_DELETE_MESSAGE.subcategory).toMatch(/^A subcategory of this category is used by a transaction that hasn't synced yet\./)
  })
})
