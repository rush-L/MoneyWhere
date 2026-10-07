import { describe, expect, it } from 'vitest'
import { categoryFromRow, groupCategories, parseCategoryName } from './category'

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
