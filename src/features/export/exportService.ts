import type { SupabaseClient } from '@supabase/supabase-js'
import { createAccountService } from '../accounts/accountService'
import { createBudgetService } from '../budgets/budgetService'
import { createCategoryService } from '../categories/categoryService'
import { createProfileService } from '../profile/profileService'
import { createTransactionService } from '../transactions/transactionService'
import { createMembershipService } from '../wallets/membershipService'
import { createWalletService } from '../wallets/walletService'
import { buildExport, type ExportDocument, type WalletExportInput } from './dataExport'

/** Message is always safe to show to the user. */
export class ExportError extends Error {}

export interface ExportProgress {
  done: number
  total: number
  label: string
}

/**
 * Fresh reads through the existing RLS-authorized services, as the signed-in user: nothing is cached, elevated or
 * taken from IndexedDB. The data is not a database snapshot; `exported_at` records when it was assembled.
 * Wallets are read one after another, each with its own paged reads.
 */
export async function loadExport(client: SupabaseClient, userId: string, onProgress: (p: ExportProgress) => void = () => {}): Promise<ExportDocument> {
  const profiles = createProfileService(client)
  const wallets = createWalletService(client)
  const members = createMembershipService(client)
  const accounts = createAccountService(client)
  const categories = createCategoryService(client)
  const budgets = createBudgetService(client)
  const transactions = createTransactionService(client)
  try {
    onProgress({ done: 0, total: 1, label: 'Loading your profile and wallets…' })
    const [profile, mine] = await Promise.all([profiles.get(userId), wallets.list(userId)])
    const out: WalletExportInput[] = []
    for (const [i, wallet] of mine.entries()) {
      onProgress({ done: i + 1, total: mine.length + 1, label: `Loading wallet ${i + 1} of ${mine.length}: ${wallet.name}…` })
      const [m, a, c, b, t] = await Promise.all([
        members.listMembers(wallet.id),
        accounts.list(wallet.id),
        categories.list(wallet.id),
        budgets.listAll(wallet.id),
        transactions.list(wallet.id),
      ])
      out.push({ wallet, members: m, accounts: a, categories: c, budgets: b, transactions: t })
    }
    onProgress({ done: mine.length + 1, total: mine.length + 1, label: 'Building the file…' })
    return buildExport({ userId, exportedAt: new Date(), profile, wallets: out })
  } catch (e) {
    console.error('[export]', e)
    throw new ExportError('Could not export your data. Check your connection and try again.')
  }
}
