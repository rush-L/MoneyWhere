import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { getAuthLink } from '../../lib/authLink'
import { supabase } from '../../lib/supabase'
import { authReducer, initialAuthState } from './authState'
import { authErrorMessage, RECOVERY_LINK_ERROR } from './errors'
import { createAuthService, type AuthService } from './services/authService'
import type { AuthState } from './types'

interface AuthContextValue {
  state: AuthState
  /** null when Supabase env is not configured. */
  service: AuthService | null
  /** Call after a successful password update (the service has already signed the user out). */
  passwordUpdated: () => void
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(authReducer, initialAuthState)
  const service = useMemo(() => (supabase ? createAuthService(supabase) : null), [])

  useEffect(() => {
    if (!service) {
      dispatch({ type: 'SESSION', session: null })
      return
    }
    // onAuthStateChange emits INITIAL_SESSION on subscribe; getSession is a fallback. Both are idempotent.
    const unsubscribe = service.onSessionChange((session, event) => dispatch({ type: 'SESSION', session, event }))
    // Recovery detection must not depend on seeing Supabase's PASSWORD_RECOVERY event: it fires once during client
    // init, possibly before this subscribes. The link was classified synchronously at init (lib/authLink), and
    // getSession() resolves after init, so decide here. A tampered/expired link leaves no session.
    service.getSession().then(
      (session) => {
        dispatch({ type: 'SESSION', session })
        const link = getAuthLink()
        if (session && link.kind === 'recovery') dispatch({ type: 'SESSION', session, event: 'PASSWORD_RECOVERY' })
        else if (!session && link.kind !== 'none') {
          dispatch({ type: 'LINK_ERROR', message: link.kind === 'error' ? authErrorMessage({ code: link.code }) : RECOVERY_LINK_ERROR })
        }
      },
      () => dispatch({ type: 'SESSION', session: null }),
    )
    return unsubscribe
  }, [service])

  const value = useMemo(() => ({ state, service, passwordUpdated: () => dispatch({ type: 'PASSWORD_UPDATED' }) }), [state, service])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
