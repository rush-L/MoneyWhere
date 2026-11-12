import type { BudgetStatus, BudgetThreshold } from '../domain/finance'
import type { Tone } from './Badge'

/** Words and colour for a budget's domain status. The text always carries the meaning; colour only reinforces. */
export function statusBadge(s: Pick<BudgetStatus, 'status' | 'remaining'>): { tone: Tone; label: string } {
  if (s.status === 'exceeded') return { tone: 'over', label: s.remaining === 0 ? 'Fully used' : 'Over budget' }
  if (s.status === 'warning') return { tone: 'caution', label: 'Near limit' }
  return { tone: 'good', label: 'On track' }
}

// The status ranges of spec section 12, as the largest/smallest value a one-decimal label may show.
const SHOWN: Record<BudgetThreshold, [number, number]> = { normal: [0, 79.9], warning: [80, 99.9], exceeded: [100, Infinity] }

/**
 * "85.0%". Truncated, never rounded, and held inside the status's own range, so a label can never say 80% or 100%
 * while the status (decided by exact integer comparison in the domain) still says otherwise. Display only.
 */
export function percentLabel(percentUsed: number, status: BudgetThreshold): string {
  const [lo, hi] = SHOWN[status]
  const truncated = Math.floor(percentUsed * 10 + 1e-9) / 10
  return `${Math.min(hi, Math.max(lo, truncated)).toFixed(1)}%`
}
