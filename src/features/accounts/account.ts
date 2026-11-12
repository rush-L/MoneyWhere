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

/** Display groups. Credit Card and Loan only exist as types for now (spec 7), so they are grouped but behave like any account. */
const CREDIT_TYPES: readonly AccountType[] = ['credit_card', 'loan']
export const isCreditType = (t: AccountType) => CREDIT_TYPES.includes(t)

export const ACCOUNT_GROUP_LABELS = { cash_bank: 'Cash & bank', credit_loans: 'Credit cards & loans' } as const
export const CREDIT_GROUP_NOTE = 'Tracked like any other account for now. A negative balance means the account is below zero.'

/**
 * Accounts split into the two display groups, each keeping the order it was given (the server's creation order).
 * A group with no accounts is omitted. Anything that is not a credit type lands in Cash & bank, so an account can
 * never disappear from the page. No totals: this only partitions.
 */
export function groupAccounts<A extends { type: AccountType }>(accounts: readonly A[]): { id: keyof typeof ACCOUNT_GROUP_LABELS; label: string; accounts: A[] }[] {
  const groups = [
    { id: 'cash_bank' as const, label: ACCOUNT_GROUP_LABELS.cash_bank, accounts: accounts.filter((a) => !isCreditType(a.type)) },
    { id: 'credit_loans' as const, label: ACCOUNT_GROUP_LABELS.credit_loans, accounts: accounts.filter((a) => isCreditType(a.type)) },
  ]
  return groups.filter((g) => g.accounts.length > 0)
}

/** "Below zero" is shown for Cash, E-wallet and Bank only. A negative Credit Card or Loan balance is normal for it and gets no badge. */
export const isBelowZeroAsset = (a: Pick<Account, 'type' | 'currentBalanceMinor'>) => !isCreditType(a.type) && a.currentBalanceMinor < 0

/**
 * Whether an account's type and opening balance are locked and whether it may be deleted. The server only knows
 * transactions it has (`hasTransactions`); a transaction still waiting in the outbox counts too, or the account would
 * look unused. `pendingIds` comes from pendingAccountUse (the outbox's own rules).
 */
export function accountLock(a: Pick<Account, 'id' | 'hasTransactions'>, pendingIds: ReadonlySet<string>) {
  const pendingOnly = !a.hasTransactions && pendingIds.has(a.id)
  return { locked: a.hasTransactions || pendingOnly, pendingOnly, canDelete: !a.hasTransactions && !pendingOnly }
}

/** Why type and opening balance are locked. Two different reasons, so two different sentences; one place so card and dialog agree. */
export const LOCK_NOTE = {
  server: 'Account type and opening balance are locked because this account has transactions.',
  pending: 'Account type and opening balance are locked until pending transactions sync.',
} as const
export const DELETE_NOTE = { server: "It can't be deleted.", pending: "It can't be deleted until they sync." } as const
export const lockNote = (pendingOnly: boolean) => (pendingOnly ? LOCK_NOTE.pending : LOCK_NOTE.server)

/** UX only (the database policies decide). An owner looking at a saved snapshot cannot write, so nothing is offered. */
export const canManageAccounts = (role: string, showingSnapshot: boolean) => role === 'owner' && !showingSnapshot

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
