import { useState, type FormEvent } from 'react'
import { useAuth } from '../AuthProvider'
import { validateNewPassword } from '../validation'
import { Button } from '../../../ui/Button'
import { Field } from '../../../ui/Field'

/** Shown only in the RECOVERY state: the user arrived through a reset link and can do nothing but set a password. */
export function ResetPasswordScreen() {
  const { service, passwordUpdated } = useAuth()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(ev: FormEvent) {
    ev.preventDefault()
    const invalid = validateNewPassword(password, confirm)
    if (invalid) return setError(invalid)
    setBusy(true)
    setError(null)
    try {
      await service!.updatePassword(password) // signs the recovery session out on success
      passwordUpdated()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.')
      setBusy(false)
    }
  }

  return (
    <main className="auth">
      <div className="card auth-card">
        <h1 className="auth-brand">MoneyWhere</h1>
        <h2>Set a new password</h2>
        <form onSubmit={(ev) => void submit(ev)} noValidate>
          <Field label="New password">
            <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          </Field>
          <Field label="Confirm new password">
            <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
          </Field>
          {error && <p role="alert" className="error">{error}</p>}
          <Button type="submit" disabled={busy}>{busy ? 'Please wait…' : 'Update password'}</Button>
        </form>
        <Button variant="ghost" disabled={busy} onClick={() => void service!.signOut().catch((e: Error) => setError(e.message))}>
          Cancel
        </Button>
      </div>
    </main>
  )
}
