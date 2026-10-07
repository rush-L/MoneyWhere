import type { Session } from '@supabase/supabase-js'

export type AuthState =
  | { status: 'LOADING' }
  | { status: 'UNAUTHENTICATED' }
  | { status: 'AUTHENTICATED'; session: Session }

export type AuthEvent = { type: 'SESSION'; session: Session | null }
