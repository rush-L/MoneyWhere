import type { ReactNode } from 'react'

export type Tone = 'neutral' | 'good' | 'caution' | 'over' | 'pending' | 'info'

/** Colour only reinforces: callers always put the meaning in the text. */
export function Badge({ tone = 'neutral', children, ...rest }: { tone?: Tone; children: ReactNode; title?: string; role?: string }) {
  return <span className={`badge badge-${tone}`} {...rest}>{children}</span>
}
