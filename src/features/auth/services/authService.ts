import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { authErrorMessage } from '../errors'

/** Message is always safe to show to the user. */
export class AuthError extends Error {}

const redirectTo = () => (import.meta.env.VITE_AUTH_REDIRECT_URL as string | undefined) || window.location.origin

function fail(err: unknown): never {
  console.error('[auth]', err)
  throw new AuthError(authErrorMessage(err))
}

export function createAuthService(client: SupabaseClient) {
  return {
    async getSession(): Promise<Session | null> {
      const { data, error } = await client.auth.getSession()
      if (error) fail(error)
      return data.session
    },
    /** Returns the unsubscribe function. */
    onSessionChange(cb: (s: Session | null) => void): () => void {
      const { data } = client.auth.onAuthStateChange((_e, s) => cb(s))
      return () => data.subscription.unsubscribe()
    },
    async signIn(email: string, password: string): Promise<void> {
      const { error } = await client.auth.signInWithPassword({ email: email.trim(), password })
      if (error) fail(error)
    },
    /** needsConfirmation is true when the email must be confirmed before a session exists. */
    async signUp(email: string, password: string): Promise<{ needsConfirmation: boolean }> {
      const { data, error } = await client.auth.signUp({
        email: email.trim(),
        password,
        options: { emailRedirectTo: redirectTo() },
      })
      if (error) fail(error)
      // With email confirmation on, an already-registered email returns a user with no identities.
      if (data.user?.identities?.length === 0) fail({ code: 'user_already_exists' })
      return { needsConfirmation: !data.session }
    },
    async signInWithGoogle(): Promise<void> {
      const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: redirectTo() } })
      if (error) fail(error)
    },
    async signOut(): Promise<void> {
      const { error } = await client.auth.signOut()
      if (error) fail(error)
    },
  }
}

export type AuthService = ReturnType<typeof createAuthService>
