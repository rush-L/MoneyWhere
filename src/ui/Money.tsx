import { formatPeso } from '../domain/finance'

/** Presentation only: formats an integer minor-unit amount via the domain display formatter (formatPeso). `prefix` is a caller-chosen explicit sign ("+", "−"). */
export function Money({ minor, prefix = '', className }: { minor: number; prefix?: string; className?: string }) {
  return <span className={`money${className ? ` ${className}` : ''}`}>{prefix}{formatPeso(minor)}</span>
}
