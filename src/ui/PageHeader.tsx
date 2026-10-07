import type { ReactNode } from 'react'
import { Button } from './Button'

export function PageHeader({ title, onBack, backLabel, actions }: { title: string; onBack?: () => void; backLabel?: string; actions?: ReactNode }) {
  return (
    <header className="page-head">
      {onBack && <Button variant="ghost" className="back" onClick={onBack}>← {backLabel ?? 'Back'}</Button>}
      <h1>{title}</h1>
      {actions && <div className="actions">{actions}</div>}
    </header>
  )
}
