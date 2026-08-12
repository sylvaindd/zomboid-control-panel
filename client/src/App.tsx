import { Routes, Route, Link, Navigate, useLocation } from 'react-router-dom'
import { useEffect, useState, useCallback, lazy, Suspense } from 'react'
import type { Socket } from 'socket.io-client'
import Layout from './components/Layout'
import RouteGuard from './components/RouteGuard'
import { ErrorBoundary } from './components/ErrorBoundary'
import {
  FeatureErrorBoundary,
} from './components/FeatureErrorBoundary'
import { Toaster } from './components/ui/toaster'
import { SocketContext, ConnectionStatus, ConnectionStatusContext } from './contexts/SocketContext'
import { ThemeProvider } from './contexts/ThemeContext'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ConfirmProvider } from './contexts/ConfirmContext'
import { TooltipProvider } from './components/ui/tooltip'
import { useToast } from './components/ui/use-toast'
import { PageSkeleton } from './components/PageSkeleton'
import { ScrollToTop } from './components/ScrollToTop'
import { isDemoMode } from './lib/demo'

type RouteLoaderMeta = {
  title: string
  description: string
  eyebrow: string
  variant: 'dashboard' | 'list' | 'form' | 'console' | 'map' | 'default'
  metrics: string[]
}

const ROUTE_LOADERS: Record<string, RouteLoaderMeta> = {
  '/': {
    title: 'Dashboard',
    description: 'Loading live server state, players, actions, and maintenance telemetry.',
    eyebrow: '// LIVE · OVERVIEW',
    variant: 'dashboard',
    metrics: ['status', 'players', 'rcon'],
  },
  '/players': {
    title: 'Online Players',
    description: 'Preparing player rows, admin actions, notes, and session details.',
    eyebrow: '// LIVE · PLAYERS',
    variant: 'list',
    metrics: ['roster', 'actions', 'notes'],
  },
  '/console': {
    title: 'Server Console',
    description: 'Opening command history, RCON state, and live output stream.',
    eyebrow: '// LIVE · CONSOLE',
    variant: 'console',
    metrics: ['rcon', 'history', 'stream'],
  },
  '/chat': {
    title: 'In-Game Chat',
    description: 'Loading bridge chat channels and recent server messages.',
    eyebrow: '// LIVE · CHAT',
    variant: 'console',
    metrics: ['bridge', 'messages', 'send'],
  },
  '/events': {
    title: 'Events & Weather',
    description: 'Preparing world controls, weather overrides, and event triggers.',
    eyebrow: '// WORLD · CONTROL',
    variant: 'form',
    metrics: ['weather', 'time', 'events'],
  },
  '/world-map': {
    title: 'World Map',
    description: 'Loading map tiles, marker tools, and player/world overlays.',
    eyebrow: '// WORLD · MAP',
    variant: 'map',
    metrics: ['tiles', 'markers', 'layers'],
  },
  '/server-config': {
    title: 'Server Configuration',
    description: 'Loading INI sections, validation, and server-safe edit controls.',
    eyebrow: '// CONFIG · INI',
    variant: 'form',
    metrics: ['ini', 'validate', 'save'],
  },
  '/mods': {
    title: 'Mod Manager',
    description: 'Loading Workshop status, active mod IDs, conflicts, and update state.',
    eyebrow: '// CONFIG · WORKSHOP',
    variant: 'list',
    metrics: ['workshop', 'mods', 'conflicts'],
  },
  '/templates': {
    title: 'Simulation Templates',
    description: 'Loading rulesets, diff previews, and apply controls.',
    eyebrow: '// CONFIG · TEMPLATES',
    variant: 'list',
    metrics: ['templates', 'diff', 'apply'],
  },
  '/scheduler': {
    title: 'Scheduled Tasks',
    description: 'Preparing task rules, run history, and automation controls.',
    eyebrow: '// MAINTAIN · SCHEDULE',
    variant: 'list',
    metrics: ['tasks', 'history', 'cron'],
  },
  '/backups': {
    title: 'World Backups',
    description: 'Loading backup inventory, restore controls, and storage status.',
    eyebrow: '// MAINTAIN · BACKUPS',
    variant: 'list',
    metrics: ['files', 'storage', 'restore'],
  },
  '/chunks': {
    title: 'Map Cleanup',
    description: 'Preparing chunk previews, safety checks, and cleanup tools.',
    eyebrow: '// MAINTAIN · MAP DATA',
    variant: 'map',
    metrics: ['chunks', 'preview', 'safe'],
  },
  '/servers': {
    title: 'My Servers',
    description: 'Loading server profiles, active target, and connection details.',
    eyebrow: '// SERVERS · PROFILES',
    variant: 'list',
    metrics: ['profiles', 'active', 'paths'],
  },
  '/server-setup': {
    title: 'Server Setup',
    description: 'Preparing install choices, paths, ports, and launch checks.',
    eyebrow: '// SERVERS · SETUP',
    variant: 'form',
    metrics: ['install', 'ports', 'start'],
  },
  '/server-finder': {
    title: 'Browse Public Servers',
    description: 'Loading discovery filters, search results, and server details.',
    eyebrow: '// SERVERS · DISCOVERY',
    variant: 'list',
    metrics: ['search', 'filters', 'results'],
  },
  '/discord': {
    title: 'Discord Integration',
    description: 'Loading bot status, channel wiring, and message controls.',
    eyebrow: '// SYSTEM · DISCORD',
    variant: 'form',
    metrics: ['bot', 'channels', 'alerts'],
  },
  '/settings': {
    title: 'Panel Settings',
    description: 'Loading access, paths, network, and panel preference controls.',
    eyebrow: '// SYSTEM · SETTINGS',
    variant: 'form',
    metrics: ['auth', 'paths', 'network'],
  },
  '/debug': {
    title: 'Debug Logs',
    description: 'Preparing diagnostics, probes, logs, and support bundle tools.',
    eyebrow: '// SYSTEM · DIAGNOSTICS',
    variant: 'console',
    metrics: ['logs', 'probes', 'bundle'],
  },
}

const AUTH_BOOT_STEPS = [
  { code: 'AUTH', label: 'Verifying credentials' },
  { code: 'LINK', label: 'Opening control channel' },
  { code: 'SYNC', label: 'Restoring panel state' },
  { code: 'NET ', label: 'Pinging live servers' },
  { code: 'OK  ', label: 'Standing by' },
]

// Lazy load larger pages for code splitting
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Players = lazy(() => import('./pages/Players'))
const Console = lazy(() => import('./pages/Console'))
const Scheduler = lazy(() => import('./pages/Scheduler'))
const Mods = lazy(() => import('./pages/Mods'))
const ChunkCleaner = lazy(() => import('./pages/ChunkCleaner'))
const Discord = lazy(() => import('./pages/Discord'))
const Settings = lazy(() => import('./pages/Settings'))
const ServerSetup = lazy(() => import('./pages/ServerSetup'))
const Servers = lazy(() => import('./pages/Servers'))
const ServerConfig = lazy(() => import('./pages/ServerConfig'))
const Templates = lazy(() => import('./pages/Templates'))
const Debug = lazy(() => import('./pages/Debug'))
const ServerFinder = lazy(() => import('./pages/ServerFinder'))
const Events = lazy(() => import('./pages/Events'))
const Chat = lazy(() => import('./pages/Chat'))
const Backups = lazy(() => import('./pages/Backups'))
const WorldMap = lazy(() => import('./pages/WorldMap'))
const Login = lazy(() => import('./pages/Login'))
const Setup = lazy(() => import('./pages/Setup'))

// Loading fallback — shows a skeleton layout instead of a plain spinner
function PageLoader() {
  const { pathname } = useLocation()
  const meta = ROUTE_LOADERS[pathname] || ROUTE_LOADERS['/']
  return <PageSkeleton {...meta} />
}

function AuthScreenLoader() {
  const [stepIndex, setStepIndex] = useState(0)
  const [tick, setTick] = useState(0)
  const totalSteps = AUTH_BOOT_STEPS.length

  useEffect(() => {
    // Advances every 350ms (was 650ms) so the full sequence takes ~1.75s
    // instead of ~3.25s for 5 steps — this animation doesn't gate anything
    // (the parent swaps it out the instant real auth resolves), but a
    // shorter total duration means less of it is ever visibly cut off
    // mid-step on a fast resolution, and less of a screen seen many times a
    // day feels like padded theater.
    const stepTimer = window.setInterval(() => {
      setStepIndex((current) => Math.min(current + 1, totalSteps - 1))
    }, 350)
    const tickTimer = window.setInterval(() => {
      setTick((current) => (current + 1) % 4)
    }, 500)
    return () => {
      window.clearInterval(stepTimer)
      window.clearInterval(tickTimer)
    }
  }, [totalSteps])

  const now = new Date()
  // Real UTC, not local time — this used to be toTimeString() (LOCAL time)
  // mislabeled "UTC" below.
  const clock = now.toISOString().slice(11, 19)
  const dots = '·'.repeat(tick) + ' '.repeat(3 - tick)
  const progress = Math.round(((stepIndex + 1) / totalSteps) * 100)
  const segments = 24
  const lit = Math.round((segments * (stepIndex + 1)) / totalSteps)

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-10">
      {/* Atmospheric backdrop */}
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{
          backgroundImage:
            'radial-gradient(ellipse at 50% 30%, hsl(var(--primary) / 0.10), transparent 55%), radial-gradient(circle at 12% 110%, hsl(var(--destructive) / 0.10), transparent 45%), linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
        }}
      />
      <div aria-hidden="true" className="control-room-sweep absolute inset-0 opacity-40" />
      {/* Vignette */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 220px 40px hsl(var(--background))' }}
      />

      {/* Top status bar */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
        <span>Project Zomboid // Control Panel</span>
        <span className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400/80 shadow-[0_0_8px_hsl(var(--primary)/0.6)]" />
          <span>Secure Handshake</span>
        </span>
      </div>

      {/* Bottom status bar */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between px-5 py-3 font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/60">
        <span>{clock} UTC</span>
        <span>STAND BY{dots}</span>
        <span>{progress.toString().padStart(3, '0')}%</span>
      </div>

      {/* Center stage */}
      <div className="relative w-full max-w-[520px]">
        {/* Corner brackets */}
        <span aria-hidden="true" className="pointer-events-none absolute -left-2 -top-2 h-5 w-5 border-l-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -right-2 -top-2 h-5 w-5 border-r-2 border-t-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -left-2 h-5 w-5 border-b-2 border-l-2 border-primary/45" />
        <span aria-hidden="true" className="pointer-events-none absolute -bottom-2 -right-2 h-5 w-5 border-b-2 border-r-2 border-primary/45" />

        <div className="relative rounded-md border border-border/60 bg-card/70 px-6 py-7 backdrop-blur-sm shadow-[0_30px_80px_-50px_hsl(var(--foreground)/0.6)]">
          {/* Header strip */}
          <div className="mb-5 flex items-center justify-between border-b border-border/50 pb-3 font-mono text-[10px] uppercase tracking-[0.28em] text-muted-foreground">
            <span className="text-primary/80">// boot.sequence</span>
            <span>node · admin</span>
          </div>

          {/* Hero row */}
          <div className="flex items-center gap-5">
            <div className="relative shrink-0">
              <img
                src={`${import.meta.env.BASE_URL}spiffo.png`}
                alt=""
                aria-hidden="true"
                className="h-16 w-16 select-none drop-shadow-[0_0_18px_hsl(var(--primary)/0.35)]"
                style={{ imageRendering: 'pixelated' }}
                draggable={false}
              />
              <span className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 animate-pulse rounded-full bg-emerald-400 ring-2 ring-card" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-[0.32em] text-muted-foreground/70">
                Establishing session
              </div>
              <div className="mt-1 truncate font-mono text-base font-semibold tracking-[0.18em] text-foreground">
                CONTROL ROOM ONLINE
              </div>
            </div>
          </div>

          {/* Boot log */}
          <ul className="mt-6 space-y-1.5 font-mono text-[11px] leading-tight" aria-live="polite">
            {AUTH_BOOT_STEPS.map((step, idx) => {
              const isDone = idx < stepIndex
              const isCurrent = idx === stepIndex
              const isPending = idx > stepIndex
              return (
                <li
                  key={step.code}
                  className={`flex items-center gap-3 transition-colors ${
                    isPending ? 'text-muted-foreground/35' : 'text-foreground/85'
                  }`}
                >
                  <span
                    className={`inline-flex h-4 w-4 items-center justify-center rounded-[3px] border text-[8px] font-semibold ${
                      isDone
                        ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-400'
                        : isCurrent
                          ? 'border-primary/60 bg-primary/15 text-primary animate-pulse'
                          : 'border-border/50 bg-transparent text-muted-foreground/50'
                    }`}
                  >
                    {isDone ? '✓' : isCurrent ? '›' : '·'}
                  </span>
                  <span className="w-10 shrink-0 uppercase tracking-[0.18em] text-muted-foreground/70">
                    {step.code}
                  </span>
                  <span className="truncate">{step.label}</span>
                  {isCurrent && (
                    <span className="ml-auto text-[10px] uppercase tracking-[0.2em] text-primary/80">
                      …
                    </span>
                  )}
                  {isDone && (
                    <span className="ml-auto text-[10px] uppercase tracking-[0.2em] text-emerald-500/70">
                      OK
                    </span>
                  )}
                </li>
              )
            })}
          </ul>

          {/* Segmented progress */}
          <div className="mt-6 flex items-center gap-[3px]" aria-hidden="true">
            {Array.from({ length: segments }).map((_, idx) => (
              <span
                key={idx}
                className={`h-1.5 flex-1 rounded-[1px] transition-colors duration-300 ${
                  idx < lit
                    ? idx === lit - 1
                      ? 'bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]'
                      : 'bg-primary/70'
                    : 'bg-border/40'
                }`}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function NotFoundRoute() {
  return (
    <div className="space-y-6 page-transition">
      <div className="rounded-xl border border-border/70 bg-card/70 p-6">
        <h1 className="text-2xl font-semibold tracking-tight">Page Not Found</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          The route you requested does not exist or is no longer available in this panel build.
        </p>
        <div className="mt-5 flex flex-wrap items-center gap-2">
          <Link to="/" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90">
            Go to Dashboard
          </Link>
          <Link to="/servers" className="inline-flex min-h-10 items-center rounded-md border border-border/70 bg-background px-4 text-sm font-medium hover:bg-muted/50">
            Open Servers
          </Link>
        </div>
      </div>
    </div>
  )
}

function AppContent() {
  const demoMode = isDemoMode()
  const [socket, setSocket] = useState<Socket | null>(null)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    reconnecting: false,
    reconnectAttempt: 0,
    error: null,
  })
  const { toast } = useToast()
  const { isAuthenticated, isLoading, needsSetup, authEnabled, getToken } = useAuth()

  const handleReconnectSuccess = useCallback(() => {
    toast({
      title: 'Reconnected',
      description: 'Connection to server restored',
      variant: 'success' as const,
    })
  }, [toast])

  useEffect(() => {
    // Don't connect socket until auth is resolved
    if (demoMode) return
    if (isLoading) return
    // If auth is enabled and user is not authenticated, don't connect
    if (authEnabled && !isAuthenticated && !needsSetup) return

    let cancelled = false
    let createdSocket: Socket | null = null

    const setupSocket = async () => {
      const { io } = await import('socket.io-client')
      if (cancelled) return

      const newSocket = io(window.location.origin, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        autoConnect: false,
      })
      createdSocket = newSocket

      const applySocketAuth = () => {
        const token = getToken()
        newSocket.auth = token ? { token } : {}
      }

      applySocketAuth()
      newSocket.connect()

      // Connection established
      newSocket.on('connect', () => {
        setConnectionStatus(prev => {
          // Show toast only on reconnect, not initial connect
          if (prev.reconnecting || prev.reconnectAttempt > 0) {
            handleReconnectSuccess()
          }
          return {
            connected: true,
            reconnecting: false,
            reconnectAttempt: 0,
            error: null,
          }
        })
        // Subscribe to updates
        newSocket.emit('subscribe:status')
        newSocket.emit('subscribe:players')
        newSocket.emit('subscribe:logs')
      })

      // Connection lost
      newSocket.on('disconnect', (reason) => {
        setConnectionStatus(prev => ({
          ...prev,
          connected: false,
          error: reason === 'io server disconnect' ? 'Server closed connection' : null,
        }))
      })

      // Connection error with detailed logging (from Socket.IO best practices)
      newSocket.on('connect_error', (err) => {
        if (newSocket.active) {
          // Temporary failure, socket will automatically reconnect
          setConnectionStatus(prev => ({
            ...prev,
            connected: false,
            reconnecting: true,
            error: err.message,
          }))
        } else {
          // Connection denied by server - needs manual reconnect
          setConnectionStatus({
            connected: false,
            reconnecting: false,
            reconnectAttempt: 0,
            error: err.message,
          })
        }
      })

      // Reconnection events
      newSocket.io.on('reconnect_attempt', (attempt) => {
        applySocketAuth()
        setConnectionStatus(prev => ({
          ...prev,
          reconnecting: true,
          reconnectAttempt: attempt,
        }))
      })

      newSocket.io.on('reconnect_failed', () => {
        setConnectionStatus({
          connected: false,
          reconnecting: false,
          reconnectAttempt: 0,
          error: 'Failed to reconnect after multiple attempts',
        })
        toast({
          title: 'Connection Lost',
          description: 'Unable to reconnect to server. Please refresh the page.',
          variant: 'destructive',
        })
      })

      setSocket(newSocket)
    }

    void setupSocket()

    return () => {
      cancelled = true
      createdSocket?.close()
    }
  }, [toast, handleReconnectSuccess, isLoading, isAuthenticated, authEnabled, needsSetup, getToken, demoMode])

  // Auth gate — show loading, setup, or login screens before main app
  if (isLoading) {
    return <AuthScreenLoader />
  }

  if (needsSetup) {
    return (
      <Suspense fallback={<AuthScreenLoader />}>
        <>
          <Setup />
          <Toaster />
        </>
      </Suspense>
    )
  }

  if (authEnabled && !isAuthenticated) {
    return (
      <Suspense fallback={<AuthScreenLoader />}>
        <>
          <Login />
          <Toaster />
        </>
      </Suspense>
    )
  }

  return (
    <ConnectionStatusContext.Provider value={connectionStatus}>
      <SocketContext.Provider value={socket}>
        <Layout>
          <ScrollToTop />
          <Suspense fallback={<PageLoader />}>
            <Routes>
              <Route path="/" element={<RouteGuard path="/"><FeatureErrorBoundary featureName="Dashboard"><Dashboard /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/dashboard" element={<Navigate to="/" replace />} />
              <Route path="/players" element={<RouteGuard path="/players"><FeatureErrorBoundary featureName="Player Management"><Players /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/console" element={<RouteGuard path="/console"><FeatureErrorBoundary featureName="Console"><Console /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/scheduler" element={<RouteGuard path="/scheduler"><FeatureErrorBoundary featureName="Scheduler"><Scheduler /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/mods" element={<RouteGuard path="/mods"><FeatureErrorBoundary featureName="Mod Manager"><Mods /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/templates" element={<RouteGuard path="/templates"><FeatureErrorBoundary featureName="Simulation Templates"><Templates /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/chunks" element={<RouteGuard path="/chunks"><FeatureErrorBoundary featureName="Chunk Cleaner"><ChunkCleaner /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/chunk-cleaner" element={<Navigate to="/chunks" replace />} />
              <Route path="/discord" element={<RouteGuard path="/discord"><FeatureErrorBoundary featureName="Discord Integration"><Discord /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/settings" element={<RouteGuard path="/settings"><FeatureErrorBoundary featureName="Settings"><Settings /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/server-setup" element={<RouteGuard path="/server-setup"><FeatureErrorBoundary featureName="Server Setup"><ServerSetup /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/servers" element={<RouteGuard path="/servers"><FeatureErrorBoundary featureName="Server Manager"><Servers /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/server-config" element={<RouteGuard path="/server-config"><FeatureErrorBoundary featureName="Server Configuration"><ServerConfig /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/serverconfig" element={<Navigate to="/server-config" replace />} />
              <Route path="/server-finder" element={<RouteGuard path="/server-finder"><FeatureErrorBoundary featureName="Server Finder"><ServerFinder /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/debug" element={<RouteGuard path="/debug"><FeatureErrorBoundary featureName="Debug"><Debug /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/events" element={<RouteGuard path="/events"><FeatureErrorBoundary featureName="Events & Weather"><Events /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/world-map" element={<RouteGuard path="/world-map"><FeatureErrorBoundary featureName="World Map"><WorldMap /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/chat" element={<RouteGuard path="/chat"><FeatureErrorBoundary featureName="In-Game Chat"><Chat /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="/backups" element={<RouteGuard path="/backups"><FeatureErrorBoundary featureName="Backups"><Backups /></FeatureErrorBoundary></RouteGuard>} />
              <Route path="*" element={<NotFoundRoute />} />
            </Routes>
          </Suspense>
        </Layout>
        <Toaster />
      </SocketContext.Provider>
    </ConnectionStatusContext.Provider>
  )
}

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <TooltipProvider>
          <AuthProvider>
            <ConfirmProvider>
              <AppContent />
            </ConfirmProvider>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  )
}

export default App
