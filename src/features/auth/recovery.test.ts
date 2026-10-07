import type { Session, SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { detectAuthCallback, getAuthLink, parseAuthHash } from '../../lib/authLink'
import { authReducer, initialAuthState } from './authState'
import { authErrorMessage, PASSWORD_UPDATED_NOTICE } from './errors'
import { createAuthService } from './services/authService'
import { validateNewPassword } from './validation'

const session = { access_token: 't', user: { id: 'u1' } } as unknown as Session
const other = { access_token: 'x', user: { id: 'u2' } } as unknown as Session

describe('recovery state', () => {
  it('PASSWORD_RECOVERY -> RECOVERY carrying the session, not AUTHENTICATED', () => {
    expect(authReducer(initialAuthState, { type: 'SESSION', session, event: 'PASSWORD_RECOVERY' })).toEqual({ status: 'RECOVERY', session })
    expect(authReducer({ status: 'AUTHENTICATED', session }, { type: 'SESSION', session, event: 'PASSWORD_RECOVERY' }).status).toBe('RECOVERY')
  })
  it('later SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED / USER_UPDATED do not downgrade RECOVERY', () => {
    for (const event of ['SIGNED_IN', 'INITIAL_SESSION', 'TOKEN_REFRESHED', 'USER_UPDATED'] as const) {
      expect(authReducer({ status: 'RECOVERY', session }, { type: 'SESSION', session: other, event })).toEqual({ status: 'RECOVERY', session: other })
    }
    expect(authReducer({ status: 'RECOVERY', session }, { type: 'SESSION', session })).toEqual({ status: 'RECOVERY', session })
  })
  it('SIGNED_OUT leaves recovery', () => {
    expect(authReducer({ status: 'RECOVERY', session }, { type: 'SESSION', session: null, event: 'SIGNED_OUT' })).toEqual({ status: 'UNAUTHENTICATED' })
  })
  it('link error and password-updated notice land on UNAUTHENTICATED; a repeated null keeps them', () => {
    const e = authReducer(initialAuthState, { type: 'LINK_ERROR', message: 'bad link' })
    expect(e).toEqual({ status: 'UNAUTHENTICATED', linkError: 'bad link' })
    expect(authReducer(e, { type: 'SESSION', session: null })).toBe(e)
    const n = authReducer({ status: 'RECOVERY', session }, { type: 'PASSWORD_UPDATED' })
    expect(n).toEqual({ status: 'UNAUTHENTICATED', notice: PASSWORD_UPDATED_NOTICE })
    expect(authReducer(n, { type: 'SESSION', session: null })).toBe(n)
  })
})

describe('auth link parsing', () => {
  it('valid recovery hash', () => {
    expect(parseAuthHash('#access_token=a&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery')).toEqual({ kind: 'recovery' })
  })
  it('error hash, including otp_expired', () => {
    const expired = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'
    expect(parseAuthHash(expired)).toEqual({ kind: 'error', code: 'otp_expired' })
    expect(parseAuthHash('#error=access_denied')).toEqual({ kind: 'error', code: 'access_denied' })
  })
  it('malformed, empty, other-type and token-less hashes are not recovery', () => {
    for (const h of ['', '#', '#%%%', '#garbage', '#type=recovery', '#access_token=a&type=signup', '#/profile']) {
      expect(parseAuthHash(h)).toEqual({ kind: 'none' })
    }
  })
  it('detectAuthCallback classifies, strips the fragment, and matches Supabase default test', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('history', { state: null, replaceState })
    const url = new URL('https://app.example/path?x=1#access_token=SECRET&type=recovery')
    expect(detectAuthCallback(url, { access_token: 'SECRET', type: 'recovery' })).toBe(true)
    expect(getAuthLink()).toEqual({ kind: 'recovery' })
    expect(replaceState).toHaveBeenCalledWith(null, '', '/path?x=1')
    replaceState.mockClear()
    expect(detectAuthCallback(new URL('https://app.example/#/x'), {})).toBe(false)
    expect(replaceState).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})

describe('password recovery service', () => {
  beforeEach(() => void vi.spyOn(console, 'error').mockImplementation(() => {}))
  const fake = (auth: object) => createAuthService({ auth } as unknown as SupabaseClient)

  it('requestPasswordReset trims the email and supplies the redirect origin', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example' } })
    const resetPasswordForEmail = vi.fn().mockResolvedValue({ data: {}, error: null })
    await fake({ resetPasswordForEmail }).requestPasswordReset('  a@b.co ')
    expect(resetPasswordForEmail).toHaveBeenCalledWith('a@b.co', { redirectTo: 'https://app.example' })
    vi.unstubAllGlobals()
  })
  it('stays neutral for unknown emails and throttling, but reports connectivity failures', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://app.example' } })
    const errors = [null, { code: 'over_request_rate_limit' }, { code: 'over_email_send_rate_limit' }, { code: 'user_not_found' }, { message: 'secret' }]
    for (const error of errors) {
      await expect(fake({ resetPasswordForEmail: async () => ({ error }) }).requestPasswordReset('x@y.co')).resolves.toBeUndefined()
    }
    const offline = fake({ resetPasswordForEmail: async () => ({ error: { name: 'AuthRetryableFetchError' } }) })
    await expect(offline.requestPasswordReset('x@y.co')).rejects.toThrow(/Cannot reach/)
    vi.unstubAllGlobals()
  })
  it('updatePassword calls updateUser, then signs out', async () => {
    const calls: string[] = []
    const updateUser = vi.fn(async () => (calls.push('update'), { error: null }))
    const signOut = vi.fn(async () => (calls.push('signOut'), { error: null }))
    await fake({ updateUser, signOut }).updatePassword('12345678')
    expect(updateUser).toHaveBeenCalledWith({ password: '12345678' })
    expect(calls).toEqual(['update', 'signOut'])
  })
  it('a failed update does not sign out and surfaces a safe message', async () => {
    const signOut = vi.fn()
    const svc = fake({ updateUser: async () => ({ error: { code: 'same_password', message: 'raw' } }), signOut })
    await expect(svc.updatePassword('12345678')).rejects.toThrow('Your new password must be different from your current password.')
    expect(signOut).not.toHaveBeenCalled()
  })
})

describe('new-password validation and recovery error mapping', () => {
  it('rejects short and mismatched, accepts valid', () => {
    expect(validateNewPassword('1234567', '1234567')).toMatch(/at least 8/)
    expect(validateNewPassword('12345678', '12345679')).toBe('Passwords do not match.')
    expect(validateNewPassword('12345678', '12345678')).toBeNull()
  })
  it('maps otp_expired, same_password and weak_password', () => {
    expect(authErrorMessage({ code: 'otp_expired' })).toBe('This reset link is invalid or has expired.')
    expect(authErrorMessage({ code: 'same_password' })).toMatch(/different from your current/)
    expect(authErrorMessage({ code: 'weak_password' })).toMatch(/too weak/)
  })
})
