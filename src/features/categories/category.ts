export interface Category {
  id: string
  walletId: string
  parentId: string | null
  name: string
}

export interface CategoryRow {
  id: string
  wallet_id: string
  parent_id: string | null
  name: string
}

export function categoryFromRow(r: CategoryRow): Category {
  return { id: r.id, walletId: r.wallet_id, parentId: r.parent_id, name: r.name }
}

/** Mirrors the DB CHECK (1-50 characters after trim). Uniqueness is enforced by the DB index only. */
export function parseCategoryName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim()
  if (!name) return { ok: false, error: 'Enter a category name.' }
  if (name.length > 50) return { ok: false, error: 'Category name must be 50 characters or fewer.' }
  return { ok: true, name }
}

export interface CategoryGroup {
  category: Category
  children: Category[]
}

const byName = (a: Category, b: Category) => a.name.localeCompare(b.name)

/** Two levels, each sorted by name. */
export function groupCategories(all: Category[]): CategoryGroup[] {
  return all
    .filter((c) => c.parentId === null)
    .sort(byName)
    .map((category) => ({ category, children: all.filter((c) => c.parentId === category.id).sort(byName) }))
}

/** Top-level categories and subcategories, counted from the loaded list. Display only. */
export function categoryCounts(all: readonly Category[]): { categories: number; subcategories: number } {
  const subcategories = all.filter((c) => c.parentId !== null).length
  return { categories: all.length - subcategories, subcategories }
}

/** "4 categories · 13 subcategories". */
export function countLine(c: { categories: number; subcategories: number }): string {
  return `${c.categories} ${c.categories === 1 ? 'category' : 'categories'} · ${c.subcategories} ${c.subcategories === 1 ? 'subcategory' : 'subcategories'}`
}

/**
 * Whether a pending expense stops this category being deleted: 'self' when it uses the category, 'subcategory' when it
 * uses one that deleting a parent would also delete, otherwise null. `pendingIds` comes from pendingCategoryUse.
 */
export function pendingDeleteBlock(c: Category, all: readonly Category[], pendingIds: ReadonlySet<string>): 'self' | 'subcategory' | null {
  if (pendingIds.has(c.id)) return 'self'
  return all.some((x) => x.parentId === c.id && pendingIds.has(x.id)) ? 'subcategory' : null
}

export const PENDING_DELETE_MESSAGE = {
  self: "This category is used by a transaction that hasn't synced yet. Sync or discard the pending transaction before deleting this category.",
  subcategory: "A subcategory of this category is used by a transaction that hasn't synced yet. Sync or discard the pending transaction before deleting this category.",
} as const
