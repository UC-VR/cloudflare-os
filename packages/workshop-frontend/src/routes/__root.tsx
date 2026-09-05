import { logRpcFailure } from '../rpcErrors'
import { useState, useEffect } from 'react'
import { createRootRoute, Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import { RpcStub } from 'capnweb'
import { AuthenticatedApi } from '@gadgets/workshop-shared/api'
// LOCAL PATCH: restricted-view — remove when fixed upstream
import type { RestrictionInfo } from '@gadgets/workshop-shared/api'
import { RestrictionProvider } from '../RestrictionContext'
import { useRpcStub, useConnectionLost } from '../RpcContext'
import { useAuth, CF_ACCESS_MODE } from '../useAuth'
import { AuthProvider } from '../AuthContext'
import { FeatureFlagsProvider } from '../FeatureFlagsContext'
import Header from '../components/Header'
import AppShell from '../components/AppShell/AppShell'
import LoginPage from '../LoginPage'
import OnboardingWizard from '../OnboardingWizard'
import AccountSelectionModal from '../components/billing/AccountSelectionModal'

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent() {
  const rpcStub = useRpcStub()
  const connectionLost = useConnectionLost()
  const { isAuthenticated, authenticatedApi, isLoading, error, logout, login } = useAuth(rpcStub)
  const pathname = useRouterState({ select: (s) => s.location.pathname })

  // Routes that don't require auth (public routes)
  const isSignup = pathname === '/signup'
  const isBlueprint = pathname.startsWith('/blueprint/')

  // A standalone (no app shell) render is used only for signed-out visitors of public routes.
  // Signed-in users get the full app chrome so public pages (esp. the blueprint detail) feel
  // native — sidebar and all — instead of floating on a bare page.
  const standalone = isSignup || (isBlueprint && !isAuthenticated)

  // The workspace editor renders fullscreen (no app chrome). /gadget/ is the legacy URL, kept
  // here so the chrome doesn't flash in during the redirect to /workspace/.
  const isWorkspaceEditor = pathname.startsWith('/workspace/') || pathname.startsWith('/gadget/')

  const handleLoginSuccess = () => {
    const token = localStorage.getItem('authToken')
    if (token) {
      login(token)
    }
  }

  // Loading state
  if (isLoading && !standalone) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-kumo-subtle">{connectionLost ? 'Waiting for server…' : 'Loading...'}</p>
      </div>
    )
  }

  // Auth error
  if (error && !standalone) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base p-6">
        <p className="text-sm text-kumo-danger">Authentication error: {error}</p>
        <button
          onClick={() => window.location.reload()}
          className="px-4 py-2 text-sm font-medium text-kumo-inverse bg-kumo-brand rounded-lg hover:bg-kumo-brand-hover transition-colors"
        >
          Retry
        </button>
      </div>
    )
  }

  // CF Access mode: show spinner while pipelined auth resolves
  if (!isAuthenticated && CF_ACCESS_MODE && !standalone) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
        <p className="text-sm text-kumo-subtle">Authenticating...</p>
      </div>
    )
  }

  // Not authenticated and not a public route — show login
  if (!isAuthenticated && !standalone) {
    return <LoginPage rpcStub={rpcStub} onLoginSuccess={handleLoginSuccess} />
  }

  // Signed-out visitors of public routes render without the auth wrapper / app shell.
  if (standalone) {
    const showHeader = !isSignup
    return (
      <TooltipProvider>
        <Toasty>
          <div className="flex h-full min-h-0 flex-col">
            {showHeader && <Header />}
            <main className="min-h-0 flex-1 overflow-y-auto">
              <Outlet />
            </main>
          </div>
        </Toasty>
      </TooltipProvider>
    )
  }

  // Authenticated — render the full shell (with onboarding gate)
  // authenticatedApi is guaranteed non-null here: isLoading, error, and
  // !isAuthenticated branches all return early above.
  if (!authenticatedApi) return null
  // LOCAL PATCH: restricted-view — remove when fixed upstream
  // The restriction is resolved BEFORE the shell mounts, so a restricted user never sees the app
  // chrome flash past on their way to the pinned workspace. Ergonomics only -- the backend denies
  // everything outside that workspace whatever the client renders.
  return (
    <RestrictedGate authenticatedApi={authenticatedApi} pathname={pathname}>
      <AuthProvider authenticatedApi={authenticatedApi} onLogout={logout}>
        <FeatureFlagsProvider>
          <TooltipProvider>
            <Toasty>
              <AuthenticatedShell
                authenticatedApi={authenticatedApi}
                isWorkspaceEditor={isWorkspaceEditor}
              />
            </Toasty>
          </TooltipProvider>
        </FeatureFlagsProvider>
      </AuthProvider>
    </RestrictedGate>
  )
}

// LOCAL PATCH: restricted-view — remove when fixed upstream
/**
 * Resolves the caller's pinned-workspace restriction and, when there is one, keeps them on that
 * workspace's route.
 *
 * getRestriction() rather than listGadgets(): the pinned workspace does not appear in a restricted
 * user's own listing until they have opened it once, so the list is useless for the FIRST
 * navigation -- which is exactly the one that matters.
 *
 * window.location.hash is preserved verbatim across the redirect because the `#share=<key>` grant
 * link is how a restricted user gets access in the first place (see useWorkspaceOpen). Dropping it
 * would break the very first login of every stakeholder.
 *
 * A failed check falls through as unrestricted on purpose: the backend is the gate, and spinning
 * forever on a transient RPC error would deny a legitimate user for no security benefit.
 */
function RestrictedGate({
  authenticatedApi,
  pathname,
  children,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  pathname: string
  children: React.ReactNode
}) {
  const navigate = useNavigate()
  const [checked, setChecked] = useState(false)
  const [restriction, setRestriction] = useState<RestrictionInfo | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getRestriction().then((result) => {
      if (!cancelled) {
        setRestriction(result ?? null)
        setChecked(true)
      }
    }).catch((err) => {
      logRpcFailure('Failed to check workspace restriction:', err)
      if (!cancelled) {
        setRestriction(null)
        setChecked(true)
      }
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  const workspace = restriction?.workspace
  const misplaced = workspace !== undefined && pathname !== `/workspace/${workspace}`

  useEffect(() => {
    if (!misplaced || workspace === undefined) return
    navigate({
      to: '/workspace/$id',
      params: { id: workspace },
      search: {},
      hash: window.location.hash.replace(/^#/, '') || undefined,
      replace: true,
    })
  }, [misplaced, workspace, navigate])

  if (!checked || misplaced) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  return <RestrictionProvider value={restriction}>{children}</RestrictionProvider>
}

/**
 * Inner shell that checks onboarding status and either shows the wizard
 * or the normal app chrome. Lives inside AuthProvider so the wizard can
 * use useAuthenticatedApi().
 */
function AuthenticatedShell({
  authenticatedApi,
  isWorkspaceEditor,
}: {
  authenticatedApi: RpcStub<AuthenticatedApi>
  isWorkspaceEditor: boolean
}) {
  // null = still checking, true = needs onboarding, false = onboarding done
  const [onboardingNeeded, setOnboardingNeeded] = useState<boolean | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.isOnboardingCompleted().then((completed) => {
      if (!cancelled) setOnboardingNeeded(!completed)
    }).catch((err) => {
      logRpcFailure('Failed to check onboarding status:', err)
      // If the check fails, skip onboarding to avoid blocking the user
      if (!cancelled) setOnboardingNeeded(false)
    })
    return () => { cancelled = true }
  }, [authenticatedApi])

  // Still checking onboarding status
  if (onboardingNeeded === null) {
    return (
      <div className="flex min-h-full items-center justify-center flex-col gap-4 bg-kumo-base">
        <div className="w-8 h-8 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
      </div>
    )
  }

  // Show onboarding wizard
  if (onboardingNeeded) {
    return <OnboardingWizard onComplete={() => setOnboardingNeeded(false)} />
  }

  // Normal app shell. The workspace editor is rendered fullscreen (no chrome); everything else
  // gets the persistent left-rail AppShell. Connection loss is surfaced by a chip in whichever of
  // those two top bars is showing, never by a banner that reflows the page (see ReconnectingChip).
  const fullscreen = isWorkspaceEditor
  return (
    <>
      <AccountSelectionModal />
      {fullscreen ? (
        <main className="h-full min-h-0">
          <Outlet />
        </main>
      ) : (
        <AppShell>
          <Outlet />
        </AppShell>
      )}
    </>
  )
}
