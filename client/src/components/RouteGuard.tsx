import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ShieldAlert } from 'lucide-react'
import { useAuth } from '@/contexts/AuthContext'
import { canAccessPath } from '@/lib/routeAccess'

/**
 * Blocks a page the signed-in role may not open.
 *
 * Hiding the sidebar entry was never enough — the route still rendered for
 * anyone who typed the URL or followed a bookmark, exposing the page's
 * read-only data even though every action on it would have been refused.
 *
 * Shows an explicit notice rather than redirecting: a silent bounce to the
 * dashboard reads as a broken link when someone opens a shared URL.
 */
export default function RouteGuard({
  path,
  children,
}: {
  path: string
  children: ReactNode
}) {
  const { can, isAdmin, isLoading } = useAuth()

  // Say nothing until the role and permission table have resolved, otherwise
  // a refresh flashes "restricted" at a user who does have access.
  if (isLoading) return null

  if (canAccessPath(path, { isAdmin, can })) return <>{children}</>

  return (
    <div className="page-transition flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-md rounded-lg border border-border/60 bg-card/50 p-6 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-muted/40">
          <ShieldAlert className="h-5 w-5 text-muted-foreground" />
        </div>
        <h1 className="text-base font-semibold">Access restricted</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your account role doesn&apos;t have access to this page. Ask a panel
          administrator if you need it.
        </p>
        <Link
          to="/"
          className="mt-4 inline-flex h-9 items-center rounded-md border border-border/60 px-3 text-sm transition-colors hover:bg-accent/40"
        >
          Back to dashboard
        </Link>
      </div>
    </div>
  )
}
