import type { ReactNode } from 'react'

/**
 * One top-level category as a card: its name (or the rename form), a muted subcategory count, quiet actions, then its
 * subcategories as divided rows. Presentation only; the page owns every action and every rule.
 */
export function CategoryCard({ title, meta, actions, footer, children }: { title: ReactNode; meta: string; actions?: ReactNode; footer?: ReactNode; children?: ReactNode }) {
  return (
    <li className="card category">
      <div className="cat-title">
        {title}
        <small className="cat-meta">{meta}</small>
      </div>
      {actions}
      {children ? <ul className="subcategory-list">{children}</ul> : null}
      {footer}
    </li>
  )
}
