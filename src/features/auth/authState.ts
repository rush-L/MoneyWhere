import { PASSWORD_UPDATED_NOTICE } from './errors'
import type { AuthEvent, AuthState } from './types'

export const initialAuthState: AuthState = { status: 'LOADING' }

/**
 * Single source of truth for auth status. Sign-out/expiry arrive as SESSION with null.
 * RECOVERY is sticky: later SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED / USER_UPDATED keep it; only sign-out leaves.
 */
export function authReducer(state: AuthState, event: AuthEvent): AuthState {
  switch (event.type) {
    case 'LINK_ERROR':
      return { status: 'UNAUTHENTICATED', linkError: event.message }
    case 'PASSWORD_UPDATED':
      return { status: 'UNAUTHENTICATED', notice: PASSWORD_UPDATED_NOTICE }
    case 'SESSION': {
      const { session } = event
      // Already signed out: keep any notice/linkError rather than clearing it on a repeated null.
      if (!session) return state.status === 'UNAUTHENTICATED' ? state : { status: 'UNAUTHENTICATED' }
      if (event.event === 'PASSWORD_RECOVERY' || state.status === 'RECOVERY') return { status: 'RECOVERY', session }
      return { status: 'AUTHENTICATED', session }
    }
  }
}
