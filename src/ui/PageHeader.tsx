import type { ReactNode } from 'react'
import { Button } from './Button'

/** `level` 2 for a page that sits under another page heading (the wallet sections under the wallet name). */
export function PageHeader({ title, onBack, backLabel, actions, level = 1 }: { title: string; onBack?: () => void; backLabel?: string; actions?: ReactNode; level?: 1 | 2 }) {
  const Heading = level === 2 ? 'h2' : 'h1'
  return (
    <header className="page-head">
      {onBack && <Button variant="ghost" className="back" onClick={onBack}>← {backLabel ?? 'Back'}</Button>}
      <Heading>{title}</Heading>
      {actions && <div className="actions">{actions}</div>}
    </header>
  )
}
