// Classifies the Supabase implicit-flow callback in the URL (recovery link, or an error redirect) and strips it
// from the address bar. Only the kind and an error code are kept; tokens are never stored or logged here.
export type AuthLink = { kind: 'none' } | { kind: 'recovery' } | { kind: 'error'; code: string }

type Params = Record<string, string | undefined>

export function parseAuthParams(p: Params): AuthLink {
  if (p.error || p.error_code || p.error_description) return { kind: 'error', code: p.error_code || p.error || 'unknown' }
  if (p.type === 'recovery' && p.access_token) return { kind: 'recovery' }
  return { kind: 'none' }
}

export function parseAuthHash(hash: string): AuthLink {
  return parseAuthParams(Object.fromEntries(new URLSearchParams(hash.replace(/^#/, ''))))
}

let captured: AuthLink = { kind: 'none' }
export const getAuthLink = () => captured

/**
 * Passed to createClient as `detectSessionInUrl`. Supabase calls it synchronously at init, with the URL it is about
 * to consume, so this sees the link before anything can miss it. The return value matches Supabase's default test;
 * the fragment is removed here, before Supabase's own `hash = ''`, so the token never stays in the history entry.
 */
export function detectAuthCallback(url: URL, params: Params): boolean {
  const isCallback = Boolean(params.access_token || params.error || params.error_description || params.error_code)
  if (isCallback) {
    captured = parseAuthParams(params)
    if (typeof history !== 'undefined') history.replaceState(history.state, '', url.pathname + url.search)
  }
  return isCallback
}
