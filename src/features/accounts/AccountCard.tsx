import type { ReactNode } from 'react'
import { Badge } from '../../ui/Badge'
import { Money } from '../../ui/Money'
import { ACCOUNT_TYPE_LABELS, isBelowZeroAsset, type Account } from './account'

/**
 * One account. Shows the balance the page already computed (server aggregate plus pending items); nothing is derived
 * here. `pendingOnly`: no server transaction yet, but queued ones use it, so the badge must not say "saved".
 * `children` is the slot for the owner's actions.
 */
export function AccountCard({ account: a, pendingOnly, children }: { account: Account; pendingOnly: boolean; children?: ReactNode }) {
  const belowZero = isBelowZeroAsset(a)
  return (
    <li className="card account">
      <div className="account-top">
        <strong>{a.name}</strong>
        <Badge>{ACCOUNT_TYPE_LABELS[a.type]}</Badge>
      </div>
      {a.holder && <small className="account-holder">Holder: {a.holder}</small>}
      <div className="account-balance">
        <small>Current balance</small>
        <b><Money minor={a.currentBalanceMinor} /></b>
      </div>
      <small className="account-opening">Opening balance <Money minor={a.openingBalanceMinor} /></small>
      {(belowZero || a.hasTransactions || pendingOnly) && (
        <div className="account-tags">
          {belowZero && <Badge tone="caution">Below zero</Badge>}
          {a.hasTransactions && <Badge tone="info">Has transactions</Badge>}
          {pendingOnly && <Badge tone="pending">Transactions waiting to sync</Badge>}
        </div>
      )}
      {children}
    </li>
  )
}
