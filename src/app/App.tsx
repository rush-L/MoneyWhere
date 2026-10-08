import { useEffect, useState } from 'react'
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
import { JoinInvitation } from '../features/wallets/JoinInvitation'
import { parseInviteHash } from '../features/wallets/membership'

// UI gating only; Supabase Auth + RLS are the real security boundary.
function Shell() {
  const { state, service } = useAuth()
  const [signOutError, setSignOutError] = useState<string | null>(null)
  const [page, setPage] = useState<'dashboard' | 'wallets' | 'profile'>('dashboard')
  // Invitation link (#/join/<token>). Kept in memory and the URL fragment only; cleared once handled.
  const [inviteToken, setInviteToken] = useState(() => parseInviteHash(window.location.hash))
  useEffect(() => {
    const onHash = () => setInviteToken(parseInviteHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])
  const closeInvite = (toWallets: boolean) => {
    history.replaceState(null, '', window.location.pathname + window.location.search)
    setInviteToken(null)
    if (toWallets) setPage('wallets')
  }

  if (state.status === 'LOADING') return <main className="auth"><State kind="loading">Loading…</State></main>
  // key: remount the screen when a notice or link error arrives so its initial mode/notice apply.
  if (state.status === 'UNAUTHENTICATED') {
    return (
      <>
        {inviteToken && <p role="status" className="note info">Sign in or create an account to accept your wallet invitation.</p>}
        <AuthScreen key={state.linkError ?? state.notice ?? ''} />
      </>
    )
  }
  if (state.status === 'RECOVERY') return <ResetPasswordScreen />

  const { user } = state.session
  return (
    <OfflineProvider key={user.id} userId={user.id}>
      <header className="app-header">
        <strong className="brand">MoneyWhere</strong>
        <nav className="main-nav" aria-label="Main">
          {(['dashboard', 'wallets', 'profile'] as const).map((p) => (
            <button key={p} type="button" aria-current={page === p ? 'page' : undefined} onClick={() => { if (inviteToken) closeInvite(false); setPage(p) }}>
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
        {inviteToken && <JoinInvitation token={inviteToken} onClose={closeInvite} />}
        {!inviteToken && page === 'dashboard' && <DashboardPage userId={user.id} />}
        {!inviteToken && page === 'wallets' && <WalletsPage userId={user.id} />}
        {!inviteToken && page === 'profile' && <ProfilePage userId={user.id} email={user.email} />}
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
