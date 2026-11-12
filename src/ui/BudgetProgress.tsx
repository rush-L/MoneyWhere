import type { ReactNode } from 'react'
import type { BudgetStatus } from '../domain/finance'
import { Badge } from './Badge'
import { percentLabel, statusBadge } from './budgetStatus'
import { Meter } from './Meter'
import { Money } from './Money'

/**
 * One budget's progress, shared by the Dashboard and the Budgets page so the same budget reads the same on both.
 * `line` is the domain's calculateBudgetStatus result; nothing is derived here. `children` is the slot for actions.
 */
export function BudgetProgress({ name, line, children }: { name: string; line: BudgetStatus; children?: ReactNode }) {
  const badge = statusBadge(line)
  return (
    <div className="budget-progress">
      <div className="bp-head">
        <strong>{name}</strong>
        <Badge tone={badge.tone}>{badge.label}</Badge>
      </div>
      <Meter percent={line.percentUsed} status={line.status} label={`${name} budget used`} />
      <div className="bp-figures">
        <span><Money minor={line.spent} /> of <Money minor={line.budget} /></span>
        <span>{percentLabel(line.percentUsed, line.status)}</span>
      </div>
      {line.over ? (
        <span className="error">{line.remaining === 0 ? 'Budget fully used' : <>Over budget by <Money minor={-line.remaining} /></>}</span>
      ) : (
        <span className="bp-remaining"><Money minor={line.remaining} /> remaining</span>
      )}
      {children}
    </div>
  )
}
