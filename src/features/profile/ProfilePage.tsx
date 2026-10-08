import { useEffect, useMemo, useState, type FormEvent } from 'react'
import { supabase } from '../../lib/supabase'
import { useAuth } from '../auth/AuthProvider'
import { parseProfileInput, type Profile } from './profile'
import { createProfileService } from './profileService'
import { Button } from '../../ui/Button'
import { Field } from '../../ui/Field'
import { PageHeader } from '../../ui/PageHeader'
import { Section } from '../../ui/Section'
import { State } from '../../ui/State'
import { ExportSection } from '../export/ExportSection'

export function ProfilePage({ userId, email }: { userId: string; email: string | undefined }) {
  const service = useMemo(() => (supabase ? createProfileService(supabase) : null), [])
  const { service: auth } = useAuth()
  const [profile, setProfile] = useState<Profile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [avatar, setAvatar] = useState('')
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)
  const [signOutError, setSignOutError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    service?.get(userId).then(
      (p) => {
        if (cancelled) return
        setProfile(p)
        setName(p.displayName ?? '')
        setAvatar(p.avatarUrl ?? '')
      },
      (e: Error) => !cancelled && setLoadError(e.message),
    )
    return () => {
      cancelled = true
    }
  }, [service, userId])

  async function save(ev: FormEvent) {
    ev.preventDefault()
    const parsed = parseProfileInput({ displayName: name, avatarUrl: avatar })
    if (!parsed.ok) return setMessage({ kind: 'error', text: parsed.error })
    setSaving(true)
    setMessage(null)
    try {
      setProfile(await service!.update(userId, parsed.value))
      setMessage({ kind: 'ok', text: 'Saved.' })
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Could not save your profile.' })
    } finally {
      setSaving(false)
    }
  }

  if (loadError) return <State kind="error">{loadError}</State>
  if (!profile) return <State kind="loading">Loading profile…</State>

  return (
    <>
      <PageHeader title="Profile" />
      <div className="card profile-id">
        {profile.avatarUrl ? (
          <img className="avatar" src={profile.avatarUrl} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="avatar" aria-hidden="true">{(profile.displayName ?? email ?? '?').charAt(0).toUpperCase()}</div>
        )}
        <div className="profile-who">
          <strong>{profile.displayName ?? email}</strong>
          {profile.displayName && <span>{email}</span>}
        </div>
      </div>
      <div className="card">
        <Section title="Your details">
          <form onSubmit={save} noValidate>
            <Field label="Display name">
              <input value={name} maxLength={50} onChange={(e) => setName(e.target.value)} disabled={saving} />
            </Field>
            <Field label="Avatar image URL (https)">
              <input type="url" value={avatar} onChange={(e) => setAvatar(e.target.value)} disabled={saving} />
            </Field>
            {message && <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'error' : 'note good'}>{message.text}</p>}
            <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </form>
        </Section>
      </div>
      <div className="card">
        <ExportSection userId={userId} />
      </div>
      <div className="card">
        <Section title="Session">
          {signOutError && <p role="alert" className="error">{signOutError}</p>}
          <div className="actions">
            <Button variant="secondary" onClick={() => auth?.signOut().catch((e: Error) => setSignOutError(e.message))}>Sign out</Button>
          </div>
        </Section>
      </div>
    </>
  )
}
