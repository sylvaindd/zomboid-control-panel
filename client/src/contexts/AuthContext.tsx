import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react'
import { clearAccessToken, getAccessToken, setAccessToken } from '../lib/authToken'

interface User {
  id: string
  username: string
  role: string
}

interface AuthState {
  user: User | null
  isAuthenticated: boolean
  isLoading: boolean
  needsSetup: boolean
  authEnabled: boolean
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  setup: (username: string, password: string, rememberMe?: boolean) => Promise<void>
  logout: () => Promise<void>
  getToken: () => string | null
  /** True when the signed-in role satisfies an operator-configurable capability. */
  can: (capability: string) => boolean
  /** True for permanently admin-only surfaces (mods, files, config, Discord, debug…). */
  isAdmin: boolean
}

const AuthContext = createContext<AuthContextType | null>(null)

// Mirrors ROLE_RANK in server/services/auth.js — a role satisfies a
// requirement when its rank is >= the required rank.
const ROLE_RANK: Record<string, number> = { viewer: 0, moderator: 1, admin: 2 }

const CORS_LOGIN_MESSAGE = 'Connection blocked by browser origin policy. For first-time reverse-proxy setup, set CORS_ORIGINS to this URL in the panel environment and restart it. Otherwise open the panel from a local/LAN address; after setup, manage origins in Settings > Remote Access.'

async function getErrorPayload(response: Response): Promise<{ error?: string } | null> {
  try {
    const data = await response.json()
    return data && typeof data === 'object' ? (data as { error?: string }) : null
  } catch {
    return null
  }
}

function getLoginErrorMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return CORS_LOGIN_MESSAGE
  }
  if (error instanceof Error && /cors|origin policy|failed to fetch/i.test(error.message)) {
    return CORS_LOGIN_MESSAGE
  }
  return "We couldn't sign you in. Check your username and password and try again."
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    isAuthenticated: false,
    isLoading: true,
    needsSetup: false,
    authEnabled: true,
  })

  // Capability -> minimum role, as configured in Settings > Users & roles.
  // Used only to hide controls the current role cannot use; the server stays
  // the enforcement boundary.
  const [permissions, setPermissions] = useState<Record<string, string>>({})

  // Get stored token
  const getToken = useCallback((): string | null => {
    return getAccessToken()
  }, [])

  // Check auth status and try auto-login
  const checkAuth = useCallback(async () => {
    try {
      // Step 1: Check if auth is needed
      const statusRes = await fetch('/api/auth/status')
      if (!statusRes.ok) {
        // Server might not have auth routes yet — allow access
        setState(prev => ({ ...prev, isLoading: false, authEnabled: false }))
        return
      }
      const status = await statusRes.json()

      if (status.needsSetup) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          needsSetup: true,
          authEnabled: false,
        }))
        return
      }

      if (!status.authEnabled) {
        setState(prev => ({
          ...prev,
          isLoading: false,
          isAuthenticated: true,
          authEnabled: false,
        }))
        return
      }

      // Step 2: Try existing token
      const token = getToken()
      if (token) {
        const meRes = await fetch('/api/auth/me', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (meRes.ok) {
          const data = await meRes.json()
          setState({
            user: data.user,
            isAuthenticated: true,
            isLoading: false,
            needsSetup: false,
            authEnabled: true,
          })
          return
        }
        // Token expired — try refresh
        clearAccessToken()
      }

      // Step 3: Try refresh token (httpOnly cookie sent automatically)
      const refreshRes = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' })
      if (refreshRes.ok) {
        const data = await refreshRes.json()
        setAccessToken(data.accessToken)
        setState({
          user: data.user,
          isAuthenticated: true,
          isLoading: false,
          needsSetup: false,
          authEnabled: true,
        })
        return
      }

      // Not authenticated
      setState(prev => ({
        ...prev,
        isLoading: false,
        isAuthenticated: false,
        authEnabled: true,
      }))
    } catch {
      // Network error — assume no auth needed (server might be starting)
      setState(prev => ({ ...prev, isLoading: false, authEnabled: false }))
    }
  }, [getToken])

  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  // Readable by any signed-in account, so this works for viewers and
  // moderators too — not just admins.
  useEffect(() => {
    if (!state.isAuthenticated || !state.authEnabled) return
    let cancelled = false
    const token = getAccessToken()
    fetch('/api/auth/permissions', {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
      .then(res => (res.ok ? res.json() : null))
      .then(data => {
        if (!cancelled && data?.permissions) setPermissions(data.permissions)
      })
      .catch(() => {
        // Leaving the table empty makes can() fall back to admin-only, which
        // hides more than necessary rather than showing something the server
        // would reject.
      })
    return () => {
      cancelled = true
    }
  }, [state.isAuthenticated, state.authEnabled])

  const isAdmin = !state.authEnabled || state.user?.role === 'admin'

  const can = useCallback(
    (capability: string): boolean => {
      // Auth disabled: the server waves every request through, so mirror it.
      if (!state.authEnabled) return true
      const role = state.user?.role
      if (!role) return false
      // Before the table arrives, assume the strictest tier so a control never
      // flashes into view and then 403s on click.
      const required = permissions[capability] ?? 'admin'
      return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[required] ?? ROLE_RANK.admin)
    },
    [state.authEnabled, state.user?.role, permissions],
  )

  const login = useCallback(async (username: string, password: string, rememberMe = true) => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include', // Send/receive cookies
        body: JSON.stringify({ username, password, rememberMe }),
      })

      if (!res.ok) {
        const data = await getErrorPayload(res)
        throw new Error(data?.error || "We couldn't sign you in. Check your username and password and try again.")
      }

      const data = await res.json()
      setAccessToken(data.accessToken)
      setState({
        user: data.user,
        isAuthenticated: true,
        isLoading: false,
        needsSetup: false,
        authEnabled: true,
      })
    } catch (error) {
      throw new Error(getLoginErrorMessage(error))
    }
  }, [])

  const setup = useCallback(async (username: string, password: string, rememberMe = true) => {
    const res = await fetch('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password, rememberMe }),
    })

    if (!res.ok) {
      const data = await res.json()
      throw new Error(data.error || "We couldn't create the admin account. Try again.")
    }

    const data = await res.json()
    setAccessToken(data.accessToken)
    setState({
      user: data.user,
      isAuthenticated: true,
      isLoading: false,
      needsSetup: false,
      authEnabled: true,
    })
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // Ignore logout errors
    }
    clearAccessToken()
    setState(prev => ({
      ...prev,
      user: null,
      isAuthenticated: false,
    }))
  }, [])

  return (
    <AuthContext.Provider value={useMemo(() => ({ ...state, login, setup, logout, getToken, can, isAdmin }), [state, login, setup, logout, getToken, can, isAdmin])}>
      {children}
    </AuthContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- hook intentionally co-located with its provider
export function useAuth() {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}
