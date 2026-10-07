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
