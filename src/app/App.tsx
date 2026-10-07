import { useState } from 'react'
import { AuthProvider, useAuth } from '../features/auth/AuthProvider'
import { OfflineProvider } from '../features/offline/hooks/OfflineProvider'
import { SyncStatus } from '../features/offline/SyncStatus'
import { AuthScreen } from '../features/auth/components/AuthScreen'
import { ResetPasswordScreen } from '../features/auth/components/ResetPasswordScreen'
import { DashboardPage } from '../features/dashboard/DashboardPage'
import { Button } from '../ui/Button'
import { State } from '../ui/State'
import { ProfilePage } from '../features/profile/ProfilePage'
import { WalletsPage } from '../features/wallets/WalletsPage'

// UI gating only; Supabase Auth + RLS are the real security boundary.
function Shell() {
  const { state, service } = useAuth()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [page, setPage] = useState<'dashboard' | 'wallets' | 'profile'>('dashboard')

  if (state.status === 'LOADING') return <main className="auth"><State kind="loading">Loading…</State></main>
  // key: remount the screen when a notice or link error arrives so its initial mode/notice apply.
  if (state.status === 'UNAUTHENTICATED') return <AuthScreen key={state.linkError ?? state.notice ?? ''} />
  if (state.status === 'RECOVERY') return <ResetPasswordScreen />

  const { user } = state.session
  return (
    <OfflineProvider key={user.id} userId={user.id}>
      <header className="app-header">
        <strong className="brand">MoneyWhere</strong>
        <nav className="main-nav" aria-label="Main">
          {(['dashboard', 'wallets', 'profile'] as const).map((p) => (
            <button key={p} type="button" aria-current={page === p ? 'page' : undefined} onClick={() => setPage(p)}>
              {p === 'dashboard' ? 'Home' : p === 'wallets' ? 'Wallets' : 'Profile'}
            </button>
          ))}
        </nav>
        <SyncStatus />
        <Button variant="ghost" onClick={() => service!.signOut().catch((e: Error) => setSignOutError(e.message))}>
          Sign out
        </Button>
      </header>
      <main className="page">
        {signOutError && <p role="alert" className="error">{signOutError}</p>}
        {page === 'dashboard' && <DashboardPage userId={user.id} />}
        {page === 'wallets' && <WalletsPage userId={user.id} />}
        {page === 'profile' && <ProfilePage userId={user.id} email={user.email} />}
      </main>
    </OfflineProvider>
  )
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
