import { describe, it, expect } from 'vitest'
import { canAccessPath, ROUTE_ACCESS } from '../routeAccess'

const admin = { isAdmin: true, can: () => true }

/** A non-admin whose configurable capabilities resolve from a fixed table. */
function role(capabilities: Record<string, boolean>) {
  return { isAdmin: false, can: (c: string) => capabilities[c] ?? false }
}

const ADMIN_ONLY = [
  '/mods',
  '/templates',
  '/server-config',
  '/backups',
  '/chunks',
  '/servers',
  '/server-setup',
  '/server-finder',
  '/discord',
  '/debug',
]

describe('canAccessPath', () => {
  it.each(ADMIN_ONLY)('denies a non-admin %s', path => {
    expect(canAccessPath(path, role({}))).toBe(false)
  })

  it.each(ADMIN_ONLY)('allows an admin %s', path => {
    expect(canAccessPath(path, admin)).toBe(true)
  })

  it('follows the configured tier for /events', () => {
    expect(canAccessPath('/events', role({ 'world.environment': true }))).toBe(true)
    expect(canAccessPath('/events', role({ 'world.environment': false }))).toBe(false)
  })

  it('follows the configured tier for /scheduler', () => {
    expect(canAccessPath('/scheduler', role({ 'scheduler.manage': true }))).toBe(true)
    expect(canAccessPath('/scheduler', role({ 'scheduler.manage': false }))).toBe(false)
  })

  it.each(['/', '/players', '/console', '/chat', '/world-map'])(
    'leaves the read-oriented page %s open',
    path => {
      expect(canAccessPath(path, role({}))).toBe(true)
    },
  )

  it('keeps /settings open so anyone can change their own password', () => {
    // The sidebar hides the entry for non-admins (navAdminOnly in Layout), but
    // the route must stay reachable or a moderator can never rotate their
    // credentials. Settings filters its own sections down to Security.
    expect(canAccessPath('/settings', role({}))).toBe(true)
  })

  it('treats an unknown path as open rather than blocking navigation', () => {
    expect(canAccessPath('/some-future-page', role({}))).toBe(true)
  })

  it('never marks a capability rule with an empty key', () => {
    for (const [path, rule] of Object.entries(ROUTE_ACCESS)) {
      if (rule.kind === 'capability') {
        expect(rule.capability, `${path} has an empty capability`).toBeTruthy()
      }
    }
  })
})
