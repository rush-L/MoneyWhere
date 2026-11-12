import type { BudgetThreshold } from '../domain/finance'
import { meterTone } from './meterTone'

/** Draws a bar from the domain's percentUsed and status. Never derives usage, remaining or status itself; only the drawn width is capped at 100%. */
export function Meter({ percent, status, label }: { percent: number; status: BudgetThreshold; label: string }) {
  const tone = meterTone(status)
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div className={`meter${tone === 'ok' ? '' : ` ${tone}`}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <span style={{ width: `${width}%` }} />
    </div>
  )
}
