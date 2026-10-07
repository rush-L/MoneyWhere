import { useState, type FormEvent } from 'react'
import { useAuth } from '../AuthProvider'
import { validateEmail, validatePassword } from '../validation'

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
      <main className="card">
        <h1>MoneyWhere</h1>
        <p role="alert" className="error">Sign-in is unavailable: the app is not connected to Supabase. See README.</p>
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
    <main className="card">
      <h1>MoneyWhere</h1>
      <h2>{mode === 'signin' ? 'Sign in' : 'Create account'}</h2>
      <form onSubmit={submit} noValidate>
        <label>
          Email
          <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={busy} />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
          />
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        {notice && <p role="status">{notice}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signin' ? 'Sign In' : 'Create Account'}
        </button>
      </form>
      <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => service.signInWithGoogle())}>
        Continue with Google
      </button>
      <p>
        {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
        <button type="button" className="link" onClick={switchMode}>
          {mode === 'signin' ? 'Create Account' : 'Sign In'}
        </button>
      </p>
    </main>
  )
}
