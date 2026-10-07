import { useState, type FormEvent } from 'react'
import { useAuth } from '../AuthProvider'
import { RESET_REQUESTED_NOTICE } from '../errors'
import { validateEmail, validatePassword } from '../validation'
import { Button } from '../../../ui/Button'
import { Field } from '../../../ui/Field'
import { State } from '../../../ui/State'

export function AuthScreen() {
  const { state, service } = useAuth()
  const arrival: { notice?: string; linkError?: string } = state.status === 'UNAUTHENTICATED' ? state : {}
  const [linkError] = useState(arrival.linkError)
  const [mode, setMode] = useState<'signin' | 'signup' | 'forgot' | 'expired'>(arrival.linkError ? 'expired' : 'signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(arrival.notice ?? null)

  if (!service) {
    return (
      <main className="auth">
        <div className="card auth-card">
          <h1 className="auth-brand">MoneyWhere</h1>
          <State kind="error">Sign-in is unavailable: the app is not connected to Supabase. See README.</State>
        </div>
      </main>
    )
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  function submit(ev: FormEvent) {
    ev.preventDefault()
    if (mode === 'forgot') {
      const invalid = validateEmail(email)
      if (invalid) return setError(invalid)
      return void run(async () => {
        await service!.requestPasswordReset(email)
        setNotice(RESET_REQUESTED_NOTICE)
      })
    }
    const passwordError = mode === 'signup' ? validatePassword(password) : password ? null : 'Enter your password.'
    const invalid = validateEmail(email) ?? passwordError
    if (invalid) return setError(invalid)
    void run(async () => {
      if (mode === 'signin') return service!.signIn(email, password)
      const { needsConfirmation } = await service!.signUp(email, password)
      if (needsConfirmation) setNotice('Check your email to confirm your account, then sign in.')
    })
  }

  function goTo(next: typeof mode) {
    setMode(next)
    setError(null)
    setNotice(null)
  }

  if (mode === 'expired') {
    return (
      <main className="auth">
        <div className="card auth-card">
          <h1 className="auth-brand">MoneyWhere</h1>
          <State kind="error">{linkError}</State>
          <Button onClick={() => goTo('forgot')}>Request a new link</Button>
          <Button variant="ghost" onClick={() => goTo('signin')}>Back to sign in</Button>
        </div>
      </main>
    )
  }

  const forgot = mode === 'forgot'

  return (
    <main className="auth">
      <div className="card auth-card">
        <h1 className="auth-brand">MoneyWhere</h1>
        <h2>{forgot ? 'Reset password' : mode === 'signin' ? 'Sign in' : 'Create account'}</h2>
        <form onSubmit={submit} noValidate>
          <Field label="Email">
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </Field>
          {!forgot && (
            <Field label="Password">
              <input
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </Field>
          )}
          {error && <p role="alert" className="error">{error}</p>}
          {notice && <p role="status" className="note info">{notice}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : forgot ? 'Send reset link' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </Button>
        </form>
        {!forgot && (
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => service.signInWithGoogle())}>
            Continue with Google
          </Button>
        )}
        <p className="auth-switch">
          {mode === 'signin' && (
            <Button variant="ghost" onClick={() => goTo('forgot')}>
              Forgot password?
            </Button>
          )}
          {forgot ? (
            <Button variant="ghost" onClick={() => goTo('signin')}>
              Back to sign in
            </Button>
          ) : (
            <>
              {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
              <Button variant="ghost" onClick={() => goTo(mode === 'signin' ? 'signup' : 'signin')}>
                {mode === 'signin' ? 'Create Account' : 'Sign In'}
              </Button>
            </>
          )}
        </p>
      </div>
    </main>
  )
}
