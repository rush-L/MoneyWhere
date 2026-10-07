import { useId, type ReactNode } from 'react'

export function Section({ title, actions, children }: { title?: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId()
  return (
    <section className="section" aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <div className="section-head">
          {title && <h2 id={id}>{title}</h2>}
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  )
}
