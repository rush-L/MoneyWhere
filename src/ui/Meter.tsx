/** Draws a bar from an already-computed percentage. Never derives usage, remaining or over-budget itself; only the drawn width is capped at 100%. */
export function Meter({ percent, over = false, label }: { percent: number; over?: boolean; label: string }) {
  const width = Math.min(100, Math.max(0, percent))
  return (
    <div className={`meter${over ? ' over' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <span style={{ width: `${width}%` }} />
    </div>
  )
}
