import type { AuthEvent, AuthState } from './types'

export const initialAuthState: AuthState = { status: 'LOADING' }

/** Single source of truth for auth status. Sign-out/expiry arrive as SESSION with null. */
export function authReducer(_state: AuthState, event: AuthEvent): AuthState {
  return event.session ? { status: 'AUTHENTICATED', session: event.session } : { status: 'UNAUTHENTICATED' }
}
