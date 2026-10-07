import type { Account } from '../accounts/account'
import type { createAccountService } from '../accounts/accountService'
import { buildDashboard, type DashboardData, type DashboardInputs } from '../dashboard/dashboard'
import type { createDashboardServiceFor } from '../dashboard/dashboardService'
import type { createTransactionService } from '../transactions/transactionService'
import { readThrough, type Cache } from './db/cache'
import type { OutboxItem } from './outbox/outbox'
import { localBalances, localSpend } from './outbox/projection'

/**
 * Local financial state = server baseline (network, else the per-user snapshot) + pending outbox items, replayed
 * through the domain. Loaders return the baseline; `project*` are pure and run on every render, so a queued item
 * shows immediately and a synced one drops out without a refetch. No IndexedDB or React in the projections.
 */
export const accountsKey = (userId: string, walletId: string) => `${userId}:accounts:${walletId}`
export const dashboardKey = (userId: string, walletId: string, month: string) => `${userId}:dashboard:${walletId}:${month}`

export interface AccountsSnapshot {
  accounts: Account[]
  /** Pending outbox ids the server already had when the snapshot was taken (they are counted by the baseline). */
  confirmed: string[]
}

/** Ids worth asking the server about: this wallet's unsynced items that can affect totals (BLOCKED never do). */
export const pendingIds = (items: readonly OutboxItem[], walletId: string): string[] =>
  items.filter((i) => i.wallet_id === walletId && i.status !== 'BLOCKED').map((i) => i.id)

export function loadAccounts(
  cache: Cache | null,
  svc: { accounts: Pick<ReturnType<typeof createAccountService>, 'list'>; tx: Pick<ReturnType<typeof createTransactionService>, 'existingIds'> },
  userId: string,
  walletId: string,
  items: readonly OutboxItem[],
) {
  return readThrough<AccountsSnapshot>(cache, accountsKey(userId, walletId), async () => {
    const [accounts, confirmed] = await Promise.all([svc.accounts.list(walletId), svc.tx.existingIds(pendingIds(items, walletId))])
    return { accounts, confirmed }
  })
}

export function loadDashboard(
  cache: Cache | null,
  svc: ReturnType<typeof createDashboardServiceFor>,
  userId: string,
  walletId: string,
  month: string,
  items: readonly OutboxItem[],
) {
  return readThrough<DashboardInputs>(cache, dashboardKey(userId, walletId, month), async () => {
    const d = await svc.load(walletId, month, pendingIds(items, walletId))
    // the Accounts page reads the same baseline, so it also works offline after only the Dashboard was opened
    cache?.put(accountsKey(userId, walletId), { accounts: d.accounts, confirmed: d.confirmed }).catch((e) => console.error('[offline] cache write failed', e))
    return d
  })
}

export const projectAccounts = (s: { accounts: readonly Account[]; confirmed: readonly string[] }, items: readonly OutboxItem[], walletId: string): Account[] =>
  localBalances(s.accounts, s.confirmed.map((id) => ({ id })), items, walletId)

/** Dashboard numbers from the same pending-aware balances and spending the other pages use (no second formula). */
export const projectDashboard = (s: DashboardInputs, items: readonly OutboxItem[], walletId: string): DashboardData =>
  buildDashboard({
    ...s,
    accounts: projectAccounts(s, items, walletId),
    spend: localSpend(s.spend, s.confirmed.map((id) => ({ id })), items, walletId),
  })
