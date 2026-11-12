import type { ReactNode } from 'react'

/** Label + one headline figure + optional supporting line. The caller passes already-computed amounts (e.g. <Money/>); nothing is derived here. */
export function SummaryCard({ label, tone, note, children }: { label: string; tone?: 'over'; note?: ReactNode; children: ReactNode }) {
  return (
    <div className="card summary-card">
      <span className="summary-label">{label}</span>
      <b className={`summary-figure${tone ? ` ${tone}` : ''}`}>{children}</b>
      {note && <small className="summary-note">{note}</small>}
    </div>
  )
}
