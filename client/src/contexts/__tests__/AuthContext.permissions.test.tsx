import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { AuthProvider, useAuth } from '../AuthContext'
import { setAccessToken, clearAccessToken } from '../../lib/authToken'

// Drives the provider's real fetch sequence: /status -> /me -> /permissions.
function mockPanel(opts: {
  role?: string
  authEnabled?: boolean
  permissions?: Record<string, string> | null
}) {
  const { role = 'moderator', authEnabled = true, permissions = {} } = opts

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      const json = (body: unknown) =>
        ({ ok: true, json: async () => body }) as unknown as Response

      if (url.endsWith('/api/auth/status')) {
        return json({ needsSetup: false, authEnabled })
      }
      if (url.endsWith('/api/auth/me')) {
        return json({ user: { id: 'u1', username: 'mod', role } })
      }
      if (url.endsWith('/api/auth/permissions')) {
        if (permissions === null) {
          return { ok: false, json: async () => ({}) } as unknown as Response
        }
        return json({ permissions, roles: ['viewer', 'moderator', 'admin'] })
      }
      return { ok: false, json: async () => ({}) } as unknown as Response
    }),
  )
}

function Probe({ capability }: { capability: string }) {
  const { can, isAdmin, isLoading, user } = useAuth()
  if (isLoading) return <span data-testid="state">loading</span>
  // `user` is reported so a test can never pass merely because nobody was
  // signed in — an unauthenticated can() is false for uninteresting reasons.
  return (
    <span data-testid="state">
      {`can=${can(capability)} admin=${isAdmin} user=${user?.role ?? 'none'}`}
    </span>
  )
}

async function renderProbe(capability: string) {
  render(
    <AuthProvider>
      <Probe capability={capability} />
    </AuthProvider>,
  )
  await waitFor(() =>
    expect(screen.getByTestId('state').textContent).not.toBe('loading'),
  )
  return () => screen.getByTestId('state').textContent ?? ''
}

beforeEach(() => {
  // The access token lives in a module variable, not storage — seeding it is
  // what makes the provider take the /api/auth/me branch.
  setAccessToken('test-token')
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearAccessToken()
})

describe('capability gating', () => {
  it('grants a moderator a moderator-tier capability', async () => {
    mockPanel({ role: 'moderator', permissions: { 'world.environment': 'moderator' } })
    const state = await renderProbe('world.environment')
    await waitFor(() => expect(state()).toBe('can=true admin=false user=moderator'))
  })

  it('denies a moderator an admin-tier capability', async () => {
    mockPanel({ role: 'moderator', permissions: { 'rcon.execute': 'admin' } })
    const state = await renderProbe('rcon.execute')
    await waitFor(() => expect(state()).toContain('user=moderator'))
    expect(state()).toBe('can=false admin=false user=moderator')
  })

  it('grants an admin a moderator-tier capability by rank', async () => {
    mockPanel({ role: 'admin', permissions: { 'players.moderate': 'moderator' } })
    const state = await renderProbe('players.moderate')
    await waitFor(() => expect(state()).toBe('can=true admin=true user=admin'))
  })

  it('follows a lowered tier — RCON becomes reachable for a moderator', async () => {
    mockPanel({ role: 'moderator', permissions: { 'rcon.execute': 'moderator' } })
    const state = await renderProbe('rcon.execute')
    await waitFor(() => expect(state()).toBe('can=true admin=false user=moderator'))
  })

  it('denies a viewer that same lowered tier', async () => {
    mockPanel({ role: 'viewer', permissions: { 'rcon.execute': 'moderator' } })
    const state = await renderProbe('rcon.execute')
    await waitFor(() => expect(state()).toContain('user=viewer'))
    expect(state()).toBe('can=false admin=false user=viewer')
  })

  it('fails closed when the permission table cannot be fetched', async () => {
    mockPanel({ role: 'admin', permissions: null })
    const state = await renderProbe('world.environment')
    await waitFor(() => expect(state()).toContain('user=admin'))
    // An admin still passes on rank; the point is the tier defaulted to admin
    // rather than to something permissive.
    expect(state()).toBe('can=true admin=true user=admin')
  })

  it('hides a moderator-tier control while the table is still missing', async () => {
    mockPanel({ role: 'moderator', permissions: null })
    const state = await renderProbe('world.environment')
    await waitFor(() => expect(state()).toContain('user=moderator'))
    expect(state()).toBe('can=false admin=false user=moderator')
  })

  it('fails closed for an unknown capability key', async () => {
    mockPanel({ role: 'moderator', permissions: { 'world.environment': 'moderator' } })
    const state = await renderProbe('not.a.capability')
    await waitFor(() => expect(state()).toContain('user=moderator'))
    expect(state()).toBe('can=false admin=false user=moderator')
  })

  it('allows everything when auth is disabled, mirroring the server', async () => {
    mockPanel({ authEnabled: false })
    const state = await renderProbe('rcon.execute')
    expect(state()).toBe('can=true admin=true user=none')
  })
})
