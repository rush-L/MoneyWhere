import { useState, type FormEvent } from 'react'
import { useAuth } from '../AuthProvider'
import { validateEmail, validatePassword } from '../validation'
import { Button } from '../../../ui/Button'
import { Field } from '../../../ui/Field'
import { State } from '../../../ui/State'

export function AuthScreen() {
  const { service } = useAuth()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

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
    const passwordError = mode === 'signup' ? validatePassword(password) : password ? null : 'Enter your password.'
    const invalid = validateEmail(email) ?? passwordError
    if (invalid) return setError(invalid)
    void run(async () => {
      if (mode === 'signin') return service!.signIn(email, password)
      const { needsConfirmation } = await service!.signUp(email, password)
      if (needsConfirmation) setNotice('Check your email to confirm your account, then sign in.')
    })
  }

  function switchMode() {
    setMode(mode === 'signin' ? 'signup' : 'signin')
    setError(null)
    setNotice(null)
  }

  return (
    <main className="auth">
      <div className="card auth-card">
        <h1 className="auth-brand">MoneyWhere</h1>
        <h2>{mode === 'signin' ? 'Sign in' : 'Create account'}</h2>
        <form onSubmit={submit} noValidate>
          <Field label="Email">
            <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
          </Field>
          <Field label="Password">
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
          </Field>
          {error && <p role="alert" className="error">{error}</p>}
          {notice && <p role="status" className="note info">{notice}</p>}
          <Button type="submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
          </Button>
        </form>
        <Button variant="secondary" disabled={busy} onClick={() => void run(() => service.signInWithGoogle())}>
          Continue with Google
        </Button>
        <p className="auth-switch">
          {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
          <Button variant="ghost" onClick={switchMode}>
            {mode === 'signin' ? 'Create Account' : 'Sign In'}
          </Button>
        </p>
      </div>
    </main>
  )
}
