import type { TransactionRow } from './transaction'

/** Search and filter state. Empty strings / arrays mean "not set". Dates are 'YYYY-MM-DD' (the stored transaction date, no timezone). */
export interface TxFilters {
  search: string
  from: string
  to: string
  categoryIds: string[]
  payerIds: string[]
  accountIds: string[]
  types: string[]
}

export const EMPTY_FILTERS: TxFilters = { search: '', from: '', to: '', categoryIds: [], payerIds: [], accountIds: [], types: [] }

/** Names as the page displays them. The payer label is whatever the client can resolve now (offline: "You" / "Another member"). */
export interface FilterLookup {
  accountName: (id: string) => string
  categoryName: (id: string) => string
  parentCategoryName: (id: string) => string | null
  payerLabel: (id: string | null) => string
}

export const TYPE_LABEL: Record<string, string> = { expense: 'Expense', income: 'Income', transfer: 'Transfer' }

export const hasFilters = (f: TxFilters) =>
  f.search.trim() !== '' || f.from !== '' || f.to !== '' || f.categoryIds.length > 0 || f.payerIds.length > 0 || f.accountIds.length > 0 || f.types.length > 0

/** Case-insensitive substring over note, account name(s), category and parent category, payer / recipient label and type label. Never ids. */
export function matchesSearch(t: TransactionRow, q: string, lk: FilterLookup): boolean {
  const needle = q.trim().toLowerCase()
  if (!needle) return true
  const fields: (string | null)[] = [t.note, TYPE_LABEL[t.type] ?? t.type, lk.accountName(t.account_id)]
  if (t.type === 'transfer') {
    if (t.destination_account_id) fields.push(lk.accountName(t.destination_account_id))
  } else {
    fields.push(lk.payerLabel(t.paid_by_user_id))
    if (t.category_id) fields.push(lk.categoryName(t.category_id), lk.parentCategoryName(t.category_id))
  }
  return fields.some((f) => !!f && f.toLowerCase().includes(needle))
}

/** AND between criteria, OR within one. A transfer matches an account filter by its source or its destination. Order is preserved. */
export function applyFilters<T extends TransactionRow>(rows: readonly T[], f: TxFilters, lk: FilterLookup): T[] {
  return rows.filter(
    (t) =>
      (!f.from || t.date >= f.from) &&
      (!f.to || t.date <= f.to) &&
      (f.types.length === 0 || f.types.includes(t.type)) &&
      (f.categoryIds.length === 0 || (t.category_id !== null && f.categoryIds.includes(t.category_id))) &&
      (f.payerIds.length === 0 || (t.paid_by_user_id !== null && f.payerIds.includes(t.paid_by_user_id))) &&
      (f.accountIds.length === 0 || f.accountIds.includes(t.account_id) || (!!t.destination_account_id && f.accountIds.includes(t.destination_account_id))) &&
      matchesSearch(t, f.search, lk),
  )
}
