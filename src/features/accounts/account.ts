import { assertMinor, parseMinor, type Currency, type Minor } from '../../domain/finance'

export const ACCOUNT_TYPES = ['cash', 'e_wallet', 'bank', 'credit_card', 'loan'] as const
export type AccountType = (typeof ACCOUNT_TYPES)[number]

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  cash: 'Cash',
  e_wallet: 'E-wallet',
  bank: 'Bank',
  credit_card: 'Credit Card',
  loan: 'Loan',
}

export interface Account {
  id: string
  walletId: string
  name: string
  type: AccountType
  openingBalanceMinor: Minor
  holder: string | null
  currency: Currency
  /** Computed server-side by `account_summaries`: opening + income - expense - transfers out + transfers in. */
  currentBalanceMinor: Minor
  /** Once true, only name/holder are editable and the account cannot be deleted (DB enforces it too). */
  hasTransactions: boolean
}

/** One row of the `account_summaries` RPC (server-side aggregate; domain `accountBalance()` is its reference). */
export interface AccountSummaryRow {
  account_id: string
  wallet_id: string
  account_name: string
  account_type: string
  holder: string | null
  currency: string
  opening_balance_minor: number
  current_balance_minor: number
  has_transactions: boolean
}

export function accountFromSummary(r: AccountSummaryRow): Account {
  return {
    id: r.account_id,
    walletId: r.wallet_id,
    name: r.account_name,
    type: r.account_type as AccountType,
    openingBalanceMinor: assertMinor(r.opening_balance_minor),
    holder: r.holder,
    currency: r.currency as Currency,
    currentBalanceMinor: assertMinor(r.current_balance_minor),
    hasTransactions: r.has_transactions,
  }
}

export interface NewAccountInput {
  name: string
  type: string
  openingBalance: string
  holder: string
}

export interface NewAccount {
  name: string
  type: AccountType
  openingBalanceMinor: Minor
  holder: string | null
}

/** Mirrors the DB CHECKs (name/holder 1-50 after trim; only credit_card/loan may start negative). */
export function parseNewAccount(i: NewAccountInput): { ok: true; value: NewAccount } | { ok: false; error: string } {
  const name = i.name.trim()
  if (!name) return { ok: false, error: 'Enter an account name.' }
  if (name.length > 50) return { ok: false, error: 'Account name must be 50 characters or fewer.' }
  if (!(ACCOUNT_TYPES as readonly string[]).includes(i.type)) return { ok: false, error: 'Choose an account type.' }
  const type = i.type as AccountType
  const holder = i.holder.trim() || null
  if (holder && holder.length > 50) return { ok: false, error: 'Holder must be 50 characters or fewer.' }
  let openingBalanceMinor: Minor
  try {
    openingBalanceMinor = assertMinor(parseMinor(i.openingBalance.trim() || '0'))
  } catch {
    return { ok: false, error: 'Enter a valid opening balance, e.g. 10000 or 250.50.' }
  }
  if (openingBalanceMinor < 0 && type !== 'credit_card' && type !== 'loan') {
    return { ok: false, error: 'Only Credit Card and Loan accounts can start with a negative balance.' }
  }
  return { ok: true, value: { name, type, openingBalanceMinor, holder } }
}

/** Columns an edit may send: after the first transaction only name/holder (the DB rejects the rest). */
export function accountUpdatePatch(a: Pick<Account, 'hasTransactions'>, v: NewAccount) {
  return a.hasTransactions
    ? { name: v.name, holder: v.holder }
    : { name: v.name, type: v.type, opening_balance_minor: v.openingBalanceMinor, holder: v.holder }
}
