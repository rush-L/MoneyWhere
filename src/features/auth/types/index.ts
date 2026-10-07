import type { AuthChangeEvent, Session } from '@supabase/supabase-js'

export type AuthState =
  | { status: 'LOADING' }
  /** notice: shown once on the sign-in screen; linkError: an invalid/expired email link. */
  | { status: 'UNAUTHENTICATED'; notice?: string; linkError?: string }
  | { status: 'AUTHENTICATED'; session: Session }
  /** Signed in only by a password-recovery link: may set a new password, nothing else. */
  | { status: 'RECOVERY'; session: Session }

export type AuthEvent =
  | { type: 'SESSION'; session: Session | null; event?: AuthChangeEvent }
  | { type: 'LINK_ERROR'; message: string }
  | { type: 'PASSWORD_UPDATED' }
