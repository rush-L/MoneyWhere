/** The UUID already exists but is not this user's row (or is invisible to them). Never retried. */
export class IntegrityError extends Error {}

export type FailureKind = 'network' | 'transient' | 'permanent'

/** Raw PostgREST error plus HTTP status; thrown by the transaction service for the sync engine to classify. */
export interface SendFailure {
  code?: string
  message?: string
  status?: number
}

/**
 * network   Supabase unreachable (browser "online" proves nothing): keep PENDING, stop the run, retry on reconnect.
 * transient 5xx / auth hiccup / unknown: FAILED, retried on the next trigger.
 * permanent RLS, FK, CHECK, integrity: BLOCKED. Retrying cannot help and must not alter the transaction.
 */
export function classifyFailure(e: unknown): FailureKind {
  if (e instanceof IntegrityError) return 'permanent'
  if (e instanceof TypeError) return 'network' // fetch() rejects with TypeError when offline
  const f = (e ?? {}) as SendFailure
  const msg = (f.message ?? '').toLowerCase()
  if (f.status === 0 || (!f.code && /failed to fetch|networkerror|network request failed|load failed/.test(msg))) return 'network'
  if (f.status === 401 || f.code === 'PGRST301' || f.code === 'PGRST303') return 'transient' // token expired; refresh then retry
  if ((f.status ?? 0) >= 500 || f.code?.startsWith('08')) return 'transient'
  if (f.code === '42501' || /^(22|23)/.test(f.code ?? '') || f.code?.startsWith('PGRST') || (f.status ?? 0) >= 400) return 'permanent'
  return 'transient'
}

export const describeFailure = (e: unknown) => {
  const f = (e ?? {}) as SendFailure
  return (e instanceof Error ? e.message : [f.code, f.message].filter(Boolean).join(': ') || 'Unknown error').slice(0, 300)
}
