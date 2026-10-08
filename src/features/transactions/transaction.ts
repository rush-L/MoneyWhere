import { assertMinor, parseMinor, type Minor, type Transaction } from '../../domain/finance'

export type TxType = 'income' | 'expense' | 'transfer'

/** Row as stored; a superset of the finance-domain Transaction, so rows feed accountBalance() directly. */
export interface TransactionRow extends Transaction {
  type: TxType
  note: string | null
  created_by: string | null // null once the creator deleted their account (shown as Former member; only the wallet owner manages the row)
  paid_by_user_id: string | null // null for transfers, and for an income/expense whose payer deleted their account (Former member)
  /** Optimistic-concurrency version from the server. Absent only in snapshots saved before Phase 11B (those rows cannot be edited offline). */
  version?: number
}

export const TRANSACTION_COLUMNS = 'id, account_id, destination_account_id, category_id, type, amount_minor, date, note, created_by, paid_by_user_id, version'

export interface TransactionInput {
  type: string
  accountId: string
  destinationAccountId: string
  categoryId: string
  amount: string
  date: string
  note: string
  /** Who paid (expense) / received (income). Empty = the server's default: the creator on create, unchanged on edit. Ignored for transfers. */
  paidByUserId?: string
}

export interface NewTransaction {
  type: TxType
  account_id: string
  destination_account_id: string | null
  category_id: string | null
  amount_minor: Minor
  date: string
  note: string | null
  /** Who paid / received. null = server default; always null for a transfer. Optional: outbox items queued before D7 have none. */
  paid_by_user_id?: string | null
}

const isRealDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s

/** Mirrors the DB CHECKs. Amount is entered positive; the sign is never stored. */
export function parseTransaction(i: TransactionInput): { ok: true; value: NewTransaction } | { ok: false; error: string } {
  if (i.type !== 'income' && i.type !== 'expense' && i.type !== 'transfer') return { ok: false, error: 'Choose income, expense or transfer.' }
  const transfer = i.type === 'transfer'
  if (!i.accountId) return { ok: false, error: transfer ? 'Choose the account to transfer from.' : 'Choose an account.' }
  if (transfer && !i.destinationAccountId) return { ok: false, error: 'Choose the account to transfer to.' }
  if (transfer && i.destinationAccountId === i.accountId) return { ok: false, error: 'Choose two different accounts.' }
  if (i.type === 'expense' && !i.categoryId) return { ok: false, error: 'Choose a category for the expense.' }
  let amount_minor: Minor
  try {
    amount_minor = assertMinor(parseMinor(i.amount.trim()))
  } catch {
    return { ok: false, error: 'Enter a valid amount, e.g. 500 or 250.50.' }
  }
  if (amount_minor <= 0) return { ok: false, error: 'Amount must be greater than zero.' }
  if (!isRealDate(i.date)) return { ok: false, error: 'Choose the transaction date.' }
  const note = i.note.trim() || null
  if (note && note.length > 500) return { ok: false, error: 'Note must be 500 characters or fewer.' }
  return {
    ok: true,
    value: { type: i.type, account_id: i.accountId, destination_account_id: transfer ? i.destinationAccountId : null, category_id: i.type === 'expense' ? i.categoryId : null, amount_minor, date: i.date, note, paid_by_user_id: transfer ? null : i.paidByUserId || null },
  }
}

/** Local calendar day as YYYY-MM-DD (not UTC, so late-evening entries don't land on tomorrow). */
export const todayLocal = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** An income/expense whose payer deleted their account (payer null): it stays "Former member" until a member is explicitly chosen. */
export const hasFormerPayer = (t: Pick<TransactionRow, 'type' | 'paid_by_user_id'> | null | undefined) => !!t && t.type !== 'transfer' && t.paid_by_user_id === null

/**
 * The payer the form submits. Empty = "keep the stored payer" (the server leaves it untouched, so null stays null).
 * An anonymized income/expense (`keepFormer`) must NOT silently become the editor: it stays "Former member" until someone
 * explicitly picks a member. Everything else defaults to the signed-in user (a transfer being converted has no payer yet,
 * so it also defaults to the user). The server enforces all of this; this only decides what the UI sends.
 */
export const resolvePayer = (keepFormer: boolean, selected: string, userId: string) => selected || (keepFormer ? '' : userId)

/** UX only; RLS enforces it. Owner manages all, a member only their own. */
export const canManage = (isOwner: boolean, t: Pick<TransactionRow, 'created_by'>, userId: string) => isOwner || t.created_by === userId
