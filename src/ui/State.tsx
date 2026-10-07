import type { ReactNode } from 'react'

/** Loading / empty / error block. `action` is the slot for Retry or a call to action. */
export function State({ kind, children, action }: { kind: 'loading' | 'empty' | 'error'; children: ReactNode; action?: ReactNode }) {
  const live = kind === 'error' ? { role: 'alert' } : kind === 'loading' ? { role: 'status', 'aria-busy': true } : {}
  return (
    <div className={`state state-${kind}`} {...live}>
      <p>{children}</p>
      {action}
    </div>
  )
}
