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
import { PrivacyPolicyPage } from '../features/legal/PrivacyPolicyPage'
import { TermsOfServicePage } from '../features/legal/TermsOfServicePage'

const NAV = {
  dashboard: { label: 'Dashboard', icon: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z' },
  wallets: { label: 'Wallets', icon: 'M3 7a2 2 0 0 1 2-2h13v4M3 7v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-1zM16 14h2' },
  profile: { label: 'Profile', icon: 'M20 21a8 8 0 0 0-16 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z' },
} as const

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
      <div className="app-shell">
        <nav className="main-nav" aria-label="Main">
          <strong className="brand nav-brand">MoneyWhere</strong>
          {(['dashboard', 'wallets', 'profile'] as const).map((p) => (
            <button key={p} type="button" aria-current={page === p ? 'page' : undefined} onClick={() => { if (inviteToken) closeInvite(false); setPage(p) }}>
              <svg aria-hidden="true" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={NAV[p].icon} /></svg>
              {NAV[p].label}
            </button>
          ))}
        </nav>
        <div className="app-body">
          <header className="app-header">
            <strong className="brand">MoneyWhere</strong>
            <SyncStatus />
            <Button variant="ghost" onClick={() => service!.signOut().catch((e: Error) => setSignOutError(e.message))}>
              Sign out
            </Button>
          </header>
          <main className={`page${page === 'dashboard' && !inviteToken ? ' page-wide' : ''}`}>
            {signOutError && <p role="alert" className="error">{signOutError}</p>}
            {inviteToken && <JoinInvitation token={inviteToken} onClose={closeInvite} />}
            {!inviteToken && page === 'dashboard' && <DashboardPage userId={user.id} />}
            {!inviteToken && page === 'wallets' && <WalletsPage userId={user.id} />}
            {!inviteToken && page === 'profile' && <ProfilePage userId={user.id} email={user.email} />}
          </main>
        </div>
      </div>
    </OfflineProvider>
  )
}

// Public pages (spec 17): plain pathname check, no router. Rendered before AuthProvider so they
// never depend on sign-in state; "back" is a full navigation back to the app, not app routing.
export function App() {
  const path = window.location.pathname
  const back = () => window.location.assign('/')
  if (path === '/privacy') return <PrivacyPolicyPage onBack={back} />
  if (path === '/terms') return <TermsOfServicePage onBack={back} />
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
