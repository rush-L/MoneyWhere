/**
 * Phase D10: the data-export document (spec 17.1). Pure: no network, no React, no Supabase. It only reshapes data that
 * was already read through the user's own RLS-authorized reads. Every output object is built field by field, so a
 * field that is not named here (an email, an avatar of someone else, a token) can never reach the file, whatever the
 * input carries.
 */
import type { Account } from '../accounts/account'
import type { Budget } from '../budgets/budget'
import type { Category } from '../categories/category'
import type { Profile } from '../profile/profile'
import type { TransactionRow } from '../transactions/transaction'
import { FORMER_MEMBER, type Member } from '../wallets/membership'
import type { Wallet } from '../wallets/wallet'

export const EXPORT_SCHEMA_VERSION = 1
export const EXPORT_APP_NAME = 'MoneyWhere'

export interface WalletExportInput {
  wallet: Wallet
  members: readonly Pick<Member, 'userId' | 'role' | 'displayName'>[]
  accounts: readonly Account[]
  categories: readonly Category[]
  budgets: readonly Budget[]
  transactions: readonly TransactionRow[]
}

export interface ExportInput {
  userId: string
  exportedAt: Date
  profile: Pick<Profile, 'displayName' | 'avatarUrl'>
  wallets: readonly WalletExportInput[]
}

/**
 * A creator/payer reference: the id only while that person is a CURRENT member of the wallet; otherwise null + a label.
 * A null id means a deleted account (Former member), except a transfer's payer (`nobody`): a transfer has none.
 */
function person(id: string | null, names: ReadonlyMap<string, string | null>, nobody = false): { id: string | null; label: string | null } {
  if (id === null) return { id: null, label: nobody ? null : FORMER_MEMBER }
  if (!names.has(id)) return { id: null, label: FORMER_MEMBER }
  return { id, label: names.get(id) ?? null }
}

export function buildExport(input: ExportInput) {
  const wallets = input.wallets.map(({ wallet, members, accounts, categories, budgets, transactions }) => {
    const names = new Map(members.map((m) => [m.userId, m.displayName] as const))
    return {
      id: wallet.id,
      name: wallet.name,
      currency: wallet.currency,
      mode: wallet.mode,
      created_at: wallet.createdAt,
      your_role: wallet.role,
      members: members.map((m) => ({ user_id: m.userId, display_name: m.displayName, role: m.role })),
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        holder: a.holder,
        currency: a.currency,
        opening_balance_minor: a.openingBalanceMinor,
        balance: { amount_minor: a.currentBalanceMinor, currency: a.currency, derived: true },
      })),
      categories: categories.map((c) => ({ id: c.id, name: c.name, parent_id: c.parentId })),
      budgets: budgets.map((b) => ({ id: b.id, category_id: b.categoryId, month: b.month, amount_minor: b.amountMinor, currency: wallet.currency })),
      transactions: transactions.map((t) => {
        const by = person(t.created_by, names)
        const paid = person(t.paid_by_user_id, names, t.type === 'transfer')
        return {
          id: t.id,
          type: t.type,
          account_id: t.account_id,
          destination_account_id: t.destination_account_id,
          category_id: t.category_id,
          amount_minor: t.amount_minor,
          currency: wallet.currency,
          date: t.date,
          note: t.note,
          created_by: by.id,
          created_by_label: by.label,
          paid_by_user_id: paid.id,
          paid_by_label: paid.label,
        }
      }),
    }
  })
  const sum = (f: (w: (typeof wallets)[number]) => number) => wallets.reduce((n, w) => n + f(w), 0)
  return {
    schema_version: EXPORT_SCHEMA_VERSION,
    app: EXPORT_APP_NAME,
    exported_at: input.exportedAt.toISOString(),
    exported_by: input.userId,
    notes: [
      'Generated in your browser from the data you can currently read. Pending offline changes are not included.',
      'A shared wallet includes transactions created by other current members, because you can already see them in the app.',
      'People who are no longer members of a wallet are exported as null with the label "Former member".',
      'Account balances are derived (computed from the opening balance and transactions), not stored values. Amounts are integer minor units.',
    ],
    counts: {
      wallets: wallets.length,
      members: sum((w) => w.members.length),
      accounts: sum((w) => w.accounts.length),
      categories: sum((w) => w.categories.length),
      budgets: sum((w) => w.budgets.length),
      transactions: sum((w) => w.transactions.length),
    },
    profile: { display_name: input.profile.displayName, avatar_url: input.profile.avatarUrl },
    wallets,
  }
}

export type ExportDocument = ReturnType<typeof buildExport>

export const exportFilename = (now: Date) => `moneywhere-export-${now.toISOString().slice(0, 10)}.json`
