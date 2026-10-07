import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { authReducer, initialAuthState } from './authState'
import { authErrorMessage } from './errors'
import { createAuthService } from './services/authService'
import { validateEmail, validatePassword } from './validation'

const session = { access_token: 't', user: { id: 'u1' } } as unknown as Session

describe('authReducer', () => {
  it('starts LOADING (no authenticated UI before the session resolves)', () => {
    expect(initialAuthState.status).toBe('LOADING')
  })
  it('session -> AUTHENTICATED', () => {
    expect(authReducer(initialAuthState, { type: 'SESSION', session })).toEqual({ status: 'AUTHENTICATED', session })
  })
  it('null session -> UNAUTHENTICATED (initial, sign-out, expiry)', () => {
    expect(authReducer(initialAuthState, { type: 'SESSION', session: null })).toEqual({ status: 'UNAUTHENTICATED' })
    expect(authReducer({ status: 'AUTHENTICATED', session }, { type: 'SESSION', session: null })).toEqual({ status: 'UNAUTHENTICATED' })
  })
})

describe('validation', () => {
  it('email', () => {
    expect(validateEmail('a@b.co')).toBeNull()
    expect(validateEmail(' a@b.co ')).toBeNull()
    for (const bad of ['', 'abc', 'a@b', 'a b@c.d']) expect(validateEmail(bad)).not.toBeNull()
  })
  it('password', () => {
    expect(validatePassword('12345678')).toBeNull()
    expect(validatePassword('1234567')).not.toBeNull()
  })
})

describe('authErrorMessage', () => {
  it('maps known codes', () => {
    expect(authErrorMessage({ code: 'invalid_credentials', message: 'Invalid login credentials' })).toBe('Incorrect email or password.')
    expect(authErrorMessage({ code: 'weak_password' })).toMatch(/too weak/)
  })
  it('maps network errors', () => {
    expect(authErrorMessage({ name: 'AuthRetryableFetchError' })).toMatch(/Cannot reach/)
    expect(authErrorMessage(new TypeError('Failed to fetch'))).toMatch(/Cannot reach/)
  })
  it('never leaks raw messages', () => {
    expect(authErrorMessage({ code: 'unknown', message: 'duplicate key value violates constraint users_pkey' })).toBe(
      'Something went wrong. Please try again.',
    )
  })
})

describe('authService', () => {
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}))
  const fake = (auth: object) => createAuthService({ auth } as unknown as SupabaseClient)

  it('signOut calls Supabase and surfaces failures as safe errors', async () => {
    const signOut = vi.fn().mockResolvedValueOnce({ error: null }).mockResolvedValueOnce({ error: { message: 'secret internals' } })
    const svc = fake({ signOut })
    await expect(svc.signOut()).resolves.toBeUndefined()
    await expect(svc.signOut()).rejects.toThrow('Something went wrong. Please try again.')
    expect(signOut).toHaveBeenCalledTimes(2)
  })
  it('signIn translates bad credentials', async () => {
    const svc = fake({ signInWithPassword: async () => ({ error: { code: 'invalid_credentials' } }) })
    await expect(svc.signIn('a@b.co', 'x')).rejects.toThrow('Incorrect email or password.')
  })
  it('signUp: confirmation required vs immediate session vs existing account', async () => {
    const mk = (data: object) => fake({ signUp: async () => ({ data, error: null }) })
    // jsdom-free: provide the origin the service reads.
    vi.stubGlobal('window', { location: { origin: 'http://localhost' } })
    expect(await mk({ user: { identities: [{}] }, session: null }).signUp('a@b.co', '12345678')).toEqual({ needsConfirmation: true })
    expect(await mk({ user: { identities: [{}] }, session }).signUp('a@b.co', '12345678')).toEqual({ needsConfirmation: false })
    await expect(mk({ user: { identities: [] }, session: null }).signUp('a@b.co', '12345678')).rejects.toThrow(/already exists/)
    vi.unstubAllGlobals()
  })
  it('Google OAuth passes provider and a non-hardcoded redirect', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example' } })
    const signInWithOAuth = vi.fn().mockResolvedValue({ error: null })
    await fake({ signInWithOAuth }).signInWithGoogle()
    expect(signInWithOAuth).toHaveBeenCalledWith({ provider: 'google', options: { redirectTo: 'https://app.example' } })
    vi.unstubAllGlobals()
  })
})
