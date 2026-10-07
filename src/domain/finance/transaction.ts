import type { Minor } from './money'

export type TransactionType = 'income' | 'expense' | 'transfer'

/**
 * Domain transaction. `id` is a client-generated UUID (idempotent offline sync later).
 * `amount_minor` is always positive; direction comes from `type`.
 * A transfer is one row: `account_id` is the source, `destination_account_id` the destination; no category.
 * Fields mirror the DB columns (snake_case) so no mapping layer is needed.
 */
export interface Transaction {
  id: string
  type: TransactionType
  amount_minor: Minor
  account_id: string
  destination_account_id?: string | null
  category_id: string | null
  date: string // calendar day, YYYY-MM-DD
}
