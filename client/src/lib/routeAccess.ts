/**
 * Who may reach which page.
 *
 * Single source of truth for the sidebar, the router guard, and the dashboard
 * shortcut tiles. Keeping one table stops those three drifting apart — hiding
 * a nav entry while the route still renders on a typed URL was exactly that
 * bug.
 *
 * This is presentation only. The server is the enforcement boundary: every
 * mutating endpoint behind these pages is already gated by requireRole or
 * requirePermission, and a denied page here would still be denied there.
 */

export type RouteAccess =
  /** Permanently admin-only — no operator setting reveals it. */
  | { kind: 'admin' }
  /** Follows an operator-configurable capability from Settings > Users & roles. */
  | { kind: 'capability'; capability: string }

/**
 * Paths absent from this map are reachable by any signed-in account. Those
 * pages are read-oriented (dashboard, players, console log, chat, world map)
 * or self-service (settings > security), and gate their own write controls
 * individually.
 */
export const ROUTE_ACCESS: Record<string, RouteAccess> = {
  // Workshop mods, server files, templates, chunk deletion, panel config,
  // Discord credentials, server profiles and diagnostics.
  '/mods': { kind: 'admin' },
  '/templates': { kind: 'admin' },
  '/server-config': { kind: 'admin' },
  '/backups': { kind: 'admin' },
  '/chunks': { kind: 'admin' },
  '/chunk-cleaner': { kind: 'admin' },
  '/servers': { kind: 'admin' },
  '/server-setup': { kind: 'admin' },
  '/server-finder': { kind: 'admin' },
  '/discord': { kind: 'admin' },
  '/debug': { kind: 'admin' },

  // Retunable from the permission matrix.
  '/events': { kind: 'capability', capability: 'world.environment' },
  '/scheduler': { kind: 'capability', capability: 'scheduler.manage' },
}

export interface AccessChecker {
  isAdmin: boolean
  can: (capability: string) => boolean
}

/** True when the current role may open `path`. Unknown paths are open. */
export function canAccessPath(path: string, checker: AccessChecker): boolean {
  const rule = ROUTE_ACCESS[path]
  if (!rule) return true
  return rule.kind === 'admin' ? checker.isAdmin : checker.can(rule.capability)
}
