import type { ReactNode } from 'react'

/** Label + a native control (input/select) + optional hint and error. The control stays the caller's. */
export function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: string; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
      {hint && <small className="field-hint">{hint}</small>}
      {error && <small role="alert" className="field-error">{error}</small>}
    </label>
  )
}
