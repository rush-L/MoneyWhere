import { add, assertMinor, sub, type Minor } from './money'
import type { Transaction } from './transaction'

/** Opening + income - expense + transfers in - transfers out, for one account. */
export function accountBalance(accountId: string, openingMinor: Minor, txs: readonly Transaction[]): Minor {
  let bal = assertMinor(openingMinor)
  for (const t of txs) {
    if (t.type === 'income' && t.account_id === accountId) bal = add(bal, t.amount_minor)
    else if (t.type === 'expense' && t.account_id === accountId) bal = sub(bal, t.amount_minor)
    else if (t.type === 'transfer') {
      if (t.account_id === accountId) bal = sub(bal, t.amount_minor)
      if (t.destination_account_id === accountId) bal = add(bal, t.amount_minor)
    }
  }
  return bal
}

export interface Totals {
  income: Minor
  expense: Minor
  transfer: Minor
}

/** Separate totals per type; transfers are never folded into expense. */
export function transactionTotals(txs: readonly Transaction[]): Totals {
  const totals: Totals = { income: 0, expense: 0, transfer: 0 }
  for (const t of txs) totals[t.type] = add(totals[t.type], t.amount_minor)
  return totals
}

/** Expense total per category_id. Income and transfers never count as spending. */
export function spendingByCategory(txs: readonly Transaction[]): Map<string, Minor> {
  const out = new Map<string, Minor>()
  for (const t of txs) {
    if (t.type === 'expense' && t.category_id) out.set(t.category_id, add(out.get(t.category_id) ?? 0, t.amount_minor))
  }
  return out
}
