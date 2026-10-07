import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from 'react'
import { supabase } from '../../lib/supabase'
import { authReducer, initialAuthState } from './authState'
import { createAuthService, type AuthService } from './services/authService'
import type { AuthState } from './types'

interface AuthContextValue {
  state: AuthState
  /** null when Supabase env is not configured. */
  service: AuthService | null
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
    const unsubscribe = service.onSessionChange((session) => dispatch({ type: 'SESSION', session }))
    service.getSession().then(
      (session) => dispatch({ type: 'SESSION', session }),
      () => dispatch({ type: 'SESSION', session: null }),
    )
    return unsubscribe
  }, [service])

  const value = useMemo(() => ({ state, service }), [state, service])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
