import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import { useEffect, useState, useContext, useMemo } from 'react'
import {
  LayoutDashboard,
  Gauge,
  Users,
  Terminal,
  Clock,
  Package,
  Settings,
  Server,
  Download,
  Bug,
  Map,
  Eraser,
  MessageSquare,
  Layers,
  ChevronDown,
  FileCog,
  LayoutTemplate,
  Menu,
  X,
  Search,
  Zap,
  MessagesSquare,
  Archive,
  AlertCircle,
  RefreshCw,
  Github,
  Coffee,
  PanelLeftClose,
  PanelLeft,
  LogOut,
  KeyRound
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { ConnectionStatus } from './ConnectionStatus'
import { SystemHealthBanner } from './SystemHealthBanner'
import { serversApi, ServerInstance, updateApi, UpdateStatus, serverApi, modsApi, panelUpdateApi } from '@/lib/api'
import { SocketContext } from '@/contexts/SocketContext'

import { useAuth } from '@/contexts/AuthContext'
import { useToast } from '@/components/ui/use-toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts'
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp'
import { preloadRouteModule } from '@/lib/routePreload'

// Standalone top-level nav item (not collapsible)
const dashboardItem = { to: '/', icon: Gauge, label: 'Dashboard' }

interface NavItem {
  to: string
  icon: typeof LayoutDashboard
  label: string
  requiresLocal?: boolean
  // Still reachable on a remote server once its Server folder is mirrored over SFTP.
  allowRemoteConfigMirror?: boolean
  disabled?: boolean
  badge?: string
  // Permanently admin-only surface — every mutating route behind it is
  // requireRole("admin") and is not operator-configurable.
  adminOnly?: boolean
  // Gated on an operator-configurable capability instead, so lowering the tier
  // in Settings > Users & roles reveals the entry.
  capability?: string
}

interface NavSection {
  id: string
  label: string
  icon: typeof LayoutDashboard
  color: string
  items: NavItem[]
}

// Navigation sections with collapsible groups
const navSections: NavSection[] = [
  {
    id: 'active',
    label: 'Live',
    icon: Terminal,
    color: 'emerald',
    items: [
      { to: '/console', icon: Terminal, label: 'Server Console' },
      { to: '/players', icon: Users, label: 'Online Players' },
      { to: '/chat', icon: MessagesSquare, label: 'In-Game Chat' },
    ]
  },
  {
    id: 'world',
    label: 'World',
    icon: Zap,
    color: 'amber',
    items: [
      { to: '/events', icon: Zap, label: 'Events & Weather', capability: 'world.environment' },
      { to: '/world-map', icon: Map, label: 'World Map' },
    ]
  },
  {
    id: 'config',
    label: 'Config',
    icon: FileCog,
    color: 'blue',
    items: [
      { to: '/server-config', icon: FileCog, label: 'Server Configuration', requiresLocal: true, allowRemoteConfigMirror: true, adminOnly: true },
      { to: '/mods', icon: Package, label: 'Mod Manager', requiresLocal: true, adminOnly: true },
      { to: '/templates', icon: LayoutTemplate, label: 'Templates', requiresLocal: true, allowRemoteConfigMirror: true, adminOnly: true },
    ]
  },
  {
    id: 'maintenance',
    label: 'Maintain',
    icon: Clock,
    color: 'purple',
    items: [
      { to: '/scheduler', icon: Clock, label: 'Scheduled Tasks', capability: 'scheduler.manage' },
      { to: '/backups', icon: Archive, label: 'World Backups', requiresLocal: true, adminOnly: true },
      { to: '/chunks', icon: Eraser, label: 'Map Cleanup', requiresLocal: true, adminOnly: true },
    ]
  },
  {
    id: 'servers',
    label: 'Servers',
    icon: Server,
    color: 'cyan',
    items: [
      { to: '/servers', icon: Layers, label: 'My Servers', adminOnly: true },
      { to: '/server-setup', icon: Download, label: 'Server Setup', adminOnly: true },
      { to: '/server-finder', icon: Search, label: 'Browse Public', adminOnly: true },
    ]
  },
  {
    id: 'system',
    label: 'Settings & Tools',
    icon: Settings,
    color: 'slate',
    items: [
      { to: '/discord', icon: MessageSquare, label: 'Discord', adminOnly: true },
      { to: '/settings', icon: Settings, label: 'Panel Settings', adminOnly: true },
      { to: '/debug', icon: Bug, label: 'Debug Logs', adminOnly: true },
    ]
  },
]

const sectionToneStyles = {
  emerald: {
    triggerActive: 'bg-success/12 border-success/35',
    iconActive: 'border-success/45 bg-success/14 text-success',
    iconIdle: 'text-foreground/86 group-hover:text-success',
    labelActive: 'text-success',
    childActive: 'border-success/45 bg-success/10',
    childDot: 'bg-success',
    childBorder: 'border-success/35',
  },
  amber: {
    triggerActive: 'bg-warning/12 border-warning/35',
    iconActive: 'border-warning/45 bg-warning/14 text-warning',
    iconIdle: 'text-foreground/86 group-hover:text-warning',
    labelActive: 'text-warning',
    childActive: 'border-warning/45 bg-warning/10',
    childDot: 'bg-warning',
    childBorder: 'border-warning/35',
  },
  blue: {
    triggerActive: 'bg-info/12 border-info/35',
    iconActive: 'border-info/45 bg-info/14 text-info',
    iconIdle: 'text-foreground/86 group-hover:text-info',
    labelActive: 'text-info',
    childActive: 'border-info/45 bg-info/10',
    childDot: 'bg-info',
    childBorder: 'border-info/35',
  },
  purple: {
    triggerActive: 'bg-accent/30 border-accent/50',
    iconActive: 'border-accent/60 bg-accent/35 text-accent-foreground',
    iconIdle: 'text-foreground/86 group-hover:text-accent-foreground',
    labelActive: 'text-accent-foreground',
    childActive: 'border-accent/60 bg-accent/25',
    childDot: 'bg-accent-foreground',
    childBorder: 'border-accent/50',
  },
  cyan: {
    triggerActive: 'bg-primary/14 border-primary/35',
    iconActive: 'border-primary/45 bg-primary/16 text-primary',
    iconIdle: 'text-foreground/86 group-hover:text-primary',
    labelActive: 'text-primary',
    childActive: 'border-primary/45 bg-primary/10',
    childDot: 'bg-primary',
    childBorder: 'border-primary/35',
  },
  slate: {
    triggerActive: 'bg-muted/45 border-border/70',
    iconActive: 'border-border/80 bg-muted text-foreground',
    iconIdle: 'text-foreground/86 group-hover:text-foreground',
    labelActive: 'text-foreground',
    childActive: 'border-border/80 bg-muted/60',
    childDot: 'bg-muted-foreground',
    childBorder: 'border-border/70',
  },
} as const

// Auth footer — shows logged-in user and logout button
function AuthFooter() {
  const { user, authEnabled, logout, isAdmin } = useAuth()

  if (!authEnabled || !user) return null

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
      <span className="min-w-0 truncate text-foreground/85 font-medium" title={user.username}>{user.username}</span>
      <span className="shrink-0 text-muted-foreground/50">·</span>
      {/* Panel Settings is hidden from non-admins, but changing your OWN
          password is self-service — so keep a way in for them. */}
      {!isAdmin && (
        <>
          <NavLink
            to="/settings?tab=security"
            className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors"
            title="Change password"
          >
            <KeyRound className="h-3 w-3" />
          </NavLink>
          <span className="shrink-0 text-muted-foreground/50">·</span>
        </>
      )}
      <button
        type="button"
        onClick={logout}
        className="shrink-0 text-muted-foreground/70 hover:text-foreground transition-colors"
        title="Sign out"
      >
        <LogOut className="h-3 w-3" />
      </button>
    </span>
  )
}

function PanelBrand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={cn("flex items-center", compact ? "gap-2" : "gap-2.5")}>
      <img
        src={`${import.meta.env.BASE_URL}spiffo.png`}
        alt="Spiffo"
        loading="lazy"
        width={compact ? 28 : 34}
        height={compact ? 28 : 34}
        className={cn(
          compact ? "h-7 w-7" : "h-[34px] w-[34px]",
          "object-contain drop-shadow-sm saturate-90"
        )}
      />
      <div className="min-w-0">
        <p
          className={cn(
            "shell-brand-title truncate uppercase leading-tight",
            compact ? "text-[13px] tracking-[0.12em]" : "text-sm tracking-[0.14em]"
          )}
        >
          Project Zomboid
        </p>
        <p
          className={cn(
            "shell-brand-subtitle truncate text-muted-foreground leading-tight",
            "text-[11px] mt-0.5"
          )}
        >
          // Control Panel
        </p>
      </div>
    </div>
  )
}

interface LayoutProps {
  children: React.ReactNode
}

export default function Layout({ children }: LayoutProps) {
  const [activeServer, setActiveServer] = useState<ServerInstance | null>(null)

  const isBlockedByRemote = (item: NavItem) =>
    !!item.requiresLocal &&
    !!activeServer?.isRemote &&
    !(item.allowRemoteConfigMirror && activeServer.remoteConfigConfigured)

  const { can, isAdmin } = useAuth()

  // Hide what the current role cannot use. Every route behind these entries is
  // already gated server-side; this only stops the sidebar advertising pages
  // that would answer 403 on arrival. A section whose items are all hidden
  // disappears entirely rather than rendering an empty group header.
  const visibleSections = useMemo(
    () =>
      navSections
        .map(section => ({
          ...section,
          items: section.items.filter(item => {
            if (item.adminOnly) return isAdmin
            if (item.capability) return can(item.capability)
            return true
          }),
        }))
        .filter(section => section.items.length > 0),
    [can, isAdmin],
  )
  const [servers, setServers] = useState<ServerInstance[]>([])
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => localStorage.getItem('sidebarCollapsed') === 'true')
  const [updateInfo, setUpdateInfo] = useState<UpdateStatus | null>(null)
  // Persist dismissal across reloads, but key it by build IDs so a NEW update
  // re-shows the banner. Was sessionStorage which got cleared on browser restart.
  const [updateDismissed, setUpdateDismissed] = useState(false)
  const [playerCount, setPlayerCount] = useState<number>(0)
  const [serverRunState, setServerRunState] = useState<'unknown' | 'running' | 'stopped' | 'transitioning'>('unknown')
  const [modUpdatesAvailable, setModUpdatesAvailable] = useState<number>(0)
  const [panelUpdateAvailable, setPanelUpdateAvailable] = useState<{ version: string | null } | null>(null)
  const [panelVersion, setPanelVersion] = useState('')
  const socket = useContext(SocketContext)
  const { toast } = useToast()
  const { helpOpen, setHelpOpen, shortcuts } = useKeyboardShortcuts()

  // Fetch panel version
  useEffect(() => {
    let cancelled = false
    fetch('/api/health')
      .then(r => r.json())
      .then(d => { if (!cancelled && d.version) setPanelVersion(d.version) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Listen for player updates globally
  useEffect(() => {
    if (!socket) return

    const handlePlayersUpdate = (players: unknown) => {
      setPlayerCount(Array.isArray(players) ? players.length : 0)
    }

    socket.on('players:update', handlePlayersUpdate)
    return () => {
      socket.off('players:update', handlePlayersUpdate)
    }
  }, [socket])
  const navigate = useNavigate()
  const location = useLocation()
  const playerCountLabel = playerCount > 99 ? '99+' : String(playerCount)

  // Toggle sidebar collapse
  const toggleSidebar = () => {
    setSidebarCollapsed(prev => {
      const next = !prev
      localStorage.setItem('sidebarCollapsed', String(next))
      return next
    })
  }

  // Track server run state for status dot on Active Server card
  useEffect(() => {
    let cancelled = false
    const apply = (data: { running?: boolean; isRunning?: boolean; isStarting?: boolean; isStopping?: boolean } | null) => {
      if (cancelled || !data) return
      if (data.isStarting || data.isStopping) setServerRunState('transitioning')
      else {
        const running = typeof data.running === 'boolean' ? data.running : data.isRunning
        if (typeof running === 'boolean') setServerRunState(running ? 'running' : 'stopped')
      }
    }
    serverApi.getStatus().then(apply).catch(() => { /* ignore — keep 'unknown' */ })
    return () => { cancelled = true }
  }, [activeServer?.id])

  useEffect(() => {
    if (!socket) return
    const onStatus = (data: { running?: boolean; isRunning?: boolean; isStarting?: boolean; isStopping?: boolean } | undefined) => {
      if (!data) return
      if (data.isStarting || data.isStopping) setServerRunState('transitioning')
      else {
        const running = typeof data.running === 'boolean' ? data.running : data.isRunning
        if (typeof running === 'boolean') setServerRunState(running ? 'running' : 'stopped')
      }
    }
    socket.on('server:status', onStatus)
    return () => { socket.off('server:status', onStatus) }
  }, [socket])

  // Track mod updates available count for Mod Manager nav badge
  useEffect(() => {
    let cancelled = false
    const refreshModStatus = async () => {
      try {
        const data = await modsApi.getStatus() as { updatesAvailable?: number } | undefined
        if (!cancelled && typeof data?.updatesAvailable === 'number') {
          setModUpdatesAvailable(data.updatesAvailable)
        }
      } catch {
        // ignore — likely 503 / not running
      }
    }
    refreshModStatus()
    if (!socket) return () => { cancelled = true }
    socket.on('mods:updates_available', refreshModStatus)
    socket.on('mods:update_detected', refreshModStatus)
    return () => {
      cancelled = true
      socket.off('mods:updates_available', refreshModStatus)
      socket.off('mods:update_detected', refreshModStatus)
    }
  }, [socket, activeServer?.id])

  // Track panel self-update availability (separate from PZ server update)
  useEffect(() => {
    let cancelled = false
    panelUpdateApi.getStatus()
      .then(s => {
        if (cancelled) return
        if (s?.updateAvailable) setPanelUpdateAvailable({ version: s.latestVersion })
        else setPanelUpdateAvailable(null)
      })
      .catch(() => { /* ignore */ })
    return () => { cancelled = true }
  }, [])

  // Close mobile menu on route change
  useEffect(() => {
    setMobileMenuOpen(false)
  }, [location.pathname])

  // Close mobile menu with Escape for keyboard users
  useEffect(() => {
    if (!mobileMenuOpen) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileMenuOpen(false)
      }
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobileMenuOpen])

  // Prevent background scroll while mobile menu is open
  useEffect(() => {
    const { body } = document
    const previousOverflow = body.style.overflow
    if (mobileMenuOpen) {
      body.style.overflow = 'hidden'
    }

    return () => {
      body.style.overflow = previousOverflow
    }
  }, [mobileMenuOpen])

  // Fetch servers and active server
  useEffect(() => {
    const fetchServers = async () => {
      try {
        const data = await serversApi.getAll()
        setServers(data.servers || [])
        const active = data.servers?.find((s: ServerInstance) => s.isActive) || null
        setActiveServer(active)
      } catch {
        toast({
          title: 'Server list unavailable',
          description: 'The panel could not load server profiles.',
          variant: 'destructive',
        })
      }
    }
    fetchServers()
  }, [toast])

  // Listen for server changes
  useEffect(() => {
    if (!socket) return

    const handleActiveServerChanged = async () => {
      try {
        const data = await serversApi.getAll()
        setServers(data.servers || [])
        const active = data.servers?.find((s: ServerInstance) => s.isActive) || null
        setActiveServer(active)
      } catch {
        toast({
          title: 'Server refresh failed',
          description: 'The active server list could not be refreshed.',
          variant: 'destructive',
        })
      }
    }

    socket.on('activeServerChanged', handleActiveServerChanged)
    return () => {
      socket.off('activeServerChanged', handleActiveServerChanged)
    }
  }, [socket, toast])

  // Listen for update notifications
  useEffect(() => {
    if (!socket) return

    const handleUpdateAvailable = (data: UpdateStatus) => {
      setUpdateInfo(data)
      // Show banner again when a different update is detected
      const dismissedKey = data?.installed && data?.latest
        ? `updateBannerDismissed:${data.installed.buildId}->${data.latest.buildId}`
        : null
      setUpdateDismissed(!!dismissedKey && localStorage.getItem(dismissedKey) === 'true')
    }

    const handleUpdateCheck = (data: UpdateStatus) => {
      if (data.updateAvailable) {
        setUpdateInfo(data)
      } else {
        setUpdateInfo(null)
      }
    }

    socket.on('server:updateAvailable', handleUpdateAvailable)
    socket.on('server:updateCheck', handleUpdateCheck)

    // Check for updates on mount
    updateApi.getStatus().then(status => {
      if (status.updateAvailable?.updateAvailable) {
        setUpdateInfo(status.updateAvailable)
      }
    }).catch(() => {})

    return () => {
      socket.off('server:updateAvailable', handleUpdateAvailable)
      socket.off('server:updateCheck', handleUpdateCheck)
    }
  }, [socket])

  const handleSwitchServer = async (server: ServerInstance) => {
    if (server.isActive) return
    try {
      await serversApi.activate(server.id)
      // Socket event will refresh the list
    } catch {
      toast({
        title: 'Switch failed',
        description: `Could not make ${server.name} the active server.`,
        variant: 'destructive',
      })
    }
  }

  return (
    <div className="flex h-screen bg-background">
      <a href="#main-content" className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-4 focus:py-2 focus:text-primary-foreground focus:text-sm">Skip to content</a>
      {/* Mobile Header */}
      <div className="fixed top-0 left-0 right-0 z-50 border-b bg-card/95 backdrop-blur supports-[backdrop-filter]:bg-card/85 lg:hidden">
        <div className="flex items-center justify-between p-3">
          <PanelBrand compact />
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
            aria-label={mobileMenuOpen ? "Close menu" : "Open menu"}
            className="h-11 w-11 rounded-lg border border-transparent hover:border-border/70 focus-visible:ring-2 focus-visible:ring-primary/60 focus-visible:ring-offset-2"
          >
            {mobileMenuOpen ? <X className="w-6 h-6" /> : <Menu className="w-6 h-6" />}
          </Button>
        </div>
      </div>

      {/* Mobile Menu Overlay */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[1px] lg:hidden"
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar - Desktop always visible, Mobile as slide-out */}
      <aside
        aria-label="Sidebar"
        className={cn(
        "fixed inset-y-0 left-0 z-40 flex flex-col border-r bg-card transform transition-all duration-300 ease-out will-change-[width,transform] motion-reduce:transition-none lg:relative",
        sidebarCollapsed ? "lg:w-[60px]" : "lg:w-64",
        "w-72",
        "lg:translate-x-0",
        mobileMenuOpen ? "translate-x-0" : "-translate-x-full",
        "pt-16 lg:pt-0" // Add padding for mobile header
      )}>
      <TooltipProvider delayDuration={150}>
        {/* Brand strip — tactical broadcast header */}
        <div className={cn("brand-strip relative overflow-hidden sidebar-header border-b border-border/50")}>
          {/* Top broadcast accent — thin ember rule */}
          <div className="brand-strip__rule" aria-hidden />
          {/* Corner stencil */}
          <div className="brand-strip__corner" aria-hidden />

          <div className={cn("relative flex items-center", sidebarCollapsed ? "justify-center p-2" : "gap-2.5 px-3 py-2.5")}>
            <div className={cn("brand-icon-frame shrink-0", sidebarCollapsed && "brand-icon-frame--sm")}
                 aria-hidden>
              <img
                src={`${import.meta.env.BASE_URL}spiffo.png`}
                alt="Spiffo"
                loading="lazy"
                width={sidebarCollapsed ? 24 : 30}
                height={sidebarCollapsed ? 24 : 30}
                className={cn(sidebarCollapsed ? "h-6 w-6" : "h-[30px] w-[30px]", "object-contain drop-shadow-sm")}
              />
            </div>
            {!sidebarCollapsed && (
              <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
                <div className="flex items-center gap-2">
                  <span className="shell-brand-title truncate text-[15px] uppercase leading-none tracking-[0.18em]">
                    Zomboid
                  </span>
                  <span className="brand-led" aria-hidden title="Panel online" />
                </div>
                <div className="flex items-center gap-1.5 text-[9.5px] font-medium uppercase leading-none tracking-[0.28em] text-muted-foreground/80">
                  <span className="shell-brand-subtitle truncate">CONTROL PANEL</span>
                  <span className="brand-strip__version font-mono normal-case tracking-normal text-muted-foreground/55">
                    v{panelVersion || (typeof __PANEL_VERSION__ !== 'undefined' ? __PANEL_VERSION__ : '0')}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Active server strip — tactical status bar */}
        {servers.length > 0 && !sidebarCollapsed && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  "active-server-strip group relative w-full border-b border-border/40 px-3 py-2.5 text-left transition-colors",
                  "focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/60",
                  `active-server-strip--${serverRunState}`
                )}
              >
                {/* Left accent edge — pulses on running, dim on stopped */}
                <span className="active-server-strip__edge" aria-hidden />

                <div className="flex items-center gap-1.5 text-[9.5px] font-medium uppercase leading-none tracking-[0.26em] text-muted-foreground/70">
                  <span>Active Server</span>
                  <span className="ml-1 inline-block h-px flex-1 bg-gradient-to-r from-border/40 to-transparent" aria-hidden />
                  <ChevronDown className="h-3 w-3 text-muted-foreground/60 transition-transform duration-200 group-data-[state=open]:rotate-180" />
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <span className="active-server-strip__dot relative h-2.5 w-2.5 shrink-0 rounded-full" aria-hidden>
                    <span className="absolute inset-0 rounded-full" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-semibold leading-tight text-foreground transition-colors group-hover:text-primary">
                    {activeServer?.name || 'No server selected'}
                  </span>
                  {serverRunState === 'running' && playerCount > 0 && (
                    <Badge
                      variant="success"
                      className="shrink-0 px-1.5 py-0 text-[10px] leading-none"
                      title={`${playerCount} player${playerCount === 1 ? '' : 's'} online`}
                    >
                      {playerCountLabel}
                    </Badge>
                  )}
                  {activeServer?.isRemote && (
                    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80" title="Remote (RCON-only) server">
                      RM
                    </Badge>
                  )}
                  <span className="sr-only">
                    {serverRunState === 'running' && 'Server is running'}
                    {serverRunState === 'stopped' && 'Server is stopped'}
                    {serverRunState === 'transitioning' && 'Server is starting or stopping'}
                    {serverRunState === 'unknown' && 'Server status unknown'}
                  </span>
                </div>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60 glass border-border/50">
              {servers.map(server => (
                <DropdownMenuItem
                  key={server.id}
                  onClick={() => handleSwitchServer(server)}
                  className={cn(
                    "py-2.5 px-3 cursor-pointer transition-colors",
                    server.isActive && 'bg-primary/10'
                  )}
                >
                  <div className="flex items-center gap-3 w-full">
                    <div className={cn(
                      "w-8 h-8 rounded-lg flex items-center justify-center",
                      server.isActive ? "bg-primary/18" : "bg-muted/70"
                    )}>
                      <Server className={cn("w-4 h-4", server.isActive && "text-primary")} />
                    </div>
                    <span className="truncate flex-1 font-medium">{server.name}</span>
                    {server.isRemote && (
                      <Badge variant="outline" className="px-1.5 py-0 text-[10px] uppercase tracking-wider text-muted-foreground/80" title="Remote (RCON-only) server">
                        Remote
                      </Badge>
                    )}
                    {server.isActive && (
                      <Badge variant="secondary" className="px-2 py-0.5 text-xs uppercase tracking-wide">
                        Active
                      </Badge>
                    )}
                  </div>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => navigate('/servers')} className="py-2.5 px-3">
                <Layers className="w-4 h-4 mr-2" />
                Manage Servers
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        {/* Navigation — flat, scannable */}
        <nav aria-label="Main navigation" className="flex-1 overflow-y-auto nav-scroll px-2 py-2">
          {/* Dashboard — always pinned at top */}
          <Tooltip>
            <TooltipTrigger asChild>
              <NavLink
                to={dashboardItem.to}
                end
                onPointerEnter={() => preloadRouteModule(dashboardItem.to)}
                onFocus={() => preloadRouteModule(dashboardItem.to)}
                onClick={() => setMobileMenuOpen(false)}
                className={cn(
                  'group relative flex min-h-9 items-center rounded-md text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                  sidebarCollapsed ? 'justify-center px-2 py-2' : 'gap-3 px-2 py-1.5',
                  location.pathname === dashboardItem.to
                    ? 'bg-primary/10 text-foreground'
                    : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
                )}
              >
                {location.pathname === dashboardItem.to && (
                  <span className="absolute left-0 top-1/2 -translate-y-1/2 h-5 w-[2px] rounded-r-full bg-primary" aria-hidden />
                )}
                <dashboardItem.icon className={cn('h-[15px] w-[15px] shrink-0', location.pathname === dashboardItem.to ? 'text-primary' : 'text-muted-foreground/80 group-hover:text-foreground')} />
                {!sidebarCollapsed && <span className="truncate">{dashboardItem.label}</span>}
              </NavLink>
            </TooltipTrigger>
            {sidebarCollapsed && <TooltipContent side="right">{dashboardItem.label}</TooltipContent>}
          </Tooltip>

          {/* Sections */}
          {visibleSections.map((section, sectionIdx) => {
            const tone = sectionToneStyles[section.color as keyof typeof sectionToneStyles] || sectionToneStyles.slate
            const sectionHasSignal =
              (section.id === 'config' && modUpdatesAvailable > 0) ||
              (section.id === 'active' && playerCount > 0) ||
              (section.id === 'system' && !!panelUpdateAvailable)

            // Collapsed (icon rail) mode — separators between sections
            if (sidebarCollapsed) {
              return (
                <div key={section.id} className={cn('space-y-0.5', sectionIdx === 0 ? 'mt-2 pt-2 border-t border-border/40' : 'mt-2 pt-2 border-t border-border/40')}>
                  {section.items.map((item) => {
                    const isDisabledByRemote = isBlockedByRemote(item)
                    if (isDisabledByRemote || item.disabled) return null
                    const isActive = location.pathname === item.to
                    return (
                      <Tooltip key={item.to}>
                        <TooltipTrigger asChild>
                          <NavLink
                            to={item.to}
                            onPointerEnter={() => preloadRouteModule(item.to)}
                            onFocus={() => preloadRouteModule(item.to)}
                            onClick={() => setMobileMenuOpen(false)}
                            className={cn(
                              'group relative flex min-h-9 items-center justify-center rounded-md px-2 py-2 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                              isActive
                                ? cn('font-medium', tone.childActive)
                                : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
                            )}
                          >
                            {isActive && (
                              <span className={cn('absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full', tone.childDot)} aria-hidden />
                            )}
                            <item.icon className={cn('h-[15px] w-[15px] shrink-0', isActive ? tone.labelActive : 'text-muted-foreground/80 group-hover:text-foreground')} />
                          </NavLink>
                        </TooltipTrigger>
                        <TooltipContent side="right">{item.label}</TooltipContent>
                      </Tooltip>
                    )
                  })}
                </div>
              )
            }

            // Expanded — flat list with lane label
            return (
              <div key={section.id} className="mt-3 first:mt-3">
                {/* Lane label */}
                <div className="mb-1 flex items-center gap-2 px-2">
                  <span className={cn('h-px w-3 rounded-full', tone.childDot)} aria-hidden />
                  <span className={cn('text-[10px] font-semibold uppercase leading-none tracking-[0.18em]', tone.labelActive)}>
                    {section.label}
                  </span>
                  {sectionHasSignal && (
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full',
                        section.id === 'active' && 'bg-success',
                        section.id === 'config' && 'bg-warning motion-safe:animate-pulse',
                        section.id === 'system' && 'bg-warning motion-safe:animate-pulse'
                      )}
                      aria-hidden
                    />
                  )}
                  <span className="h-px flex-1 bg-border/30" aria-hidden />
                </div>
                <div className="space-y-0.5">
                  {section.items.map((item) => {
                    const isDisabledByRemote = isBlockedByRemote(item)

                    if (item.disabled) {
                      return (
                        <div
                          key={item.to}
                          className="flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] opacity-50 cursor-not-allowed"
                          title={item.label}
                          aria-disabled="true"
                        >
                          <item.icon className="h-[15px] w-[15px] shrink-0 text-muted-foreground/50" />
                          <span className="truncate text-muted-foreground/70">{item.label}</span>
                        </div>
                      )
                    }

                    if (isDisabledByRemote) {
                      return (
                        <div
                          key={item.to}
                          className="flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] opacity-55"
                          title="Not available for remote (RCON-only) servers"
                          aria-disabled="true"
                        >
                          <item.icon className="h-[15px] w-[15px] shrink-0 text-muted-foreground/50" />
                          <span className="truncate text-muted-foreground/70 line-through decoration-muted-foreground/30">{item.label}</span>
                          <Badge variant="outline" className="ml-auto px-1 py-0 text-[9px] uppercase tracking-wider">
                            Local
                          </Badge>
                        </div>
                      )
                    }

                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        onPointerEnter={() => preloadRouteModule(item.to)}
                        onFocus={() => preloadRouteModule(item.to)}
                        onClick={() => setMobileMenuOpen(false)}
                        className={({ isActive }) =>
                          cn(
                            'group relative flex min-h-9 items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/60',
                            isActive
                              ? cn('font-medium text-foreground', tone.childActive)
                              : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground'
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {isActive && (
                              <span className={cn('absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[2px] rounded-r-full', tone.childDot)} aria-hidden />
                            )}
                            <item.icon className={cn('h-[15px] w-[15px] shrink-0 transition-colors', isActive ? tone.labelActive : 'text-muted-foreground/80 group-hover:text-foreground')} />
                            <span className="truncate">{item.label}</span>
                            {item.badge && (
                              <Badge
                                variant={isActive ? 'secondary' : 'outline'}
                                className="ml-auto px-1.5 py-0 text-[10px] uppercase tracking-wider text-warning border-warning/40"
                              >
                                {item.badge}
                              </Badge>
                            )}
                            {item.to === '/players' && playerCount > 0 && (
                              <Badge
                                variant={isActive ? 'secondary' : 'success'}
                                className="ml-auto min-w-[24px] justify-center px-1.5 py-0 text-[10px] leading-tight"
                              >
                                {playerCountLabel}
                              </Badge>
                            )}
                            {item.to === '/mods' && modUpdatesAvailable > 0 && (
                              <Badge
                                variant="warning"
                                className="ml-auto min-w-[24px] justify-center px-1.5 py-0 text-[10px] leading-tight"
                                title={`${modUpdatesAvailable} mod update${modUpdatesAvailable === 1 ? '' : 's'} available`}
                              >
                                {modUpdatesAvailable > 99 ? '99+' : modUpdatesAvailable}
                              </Badge>
                            )}
                            {item.to === '/settings' && panelUpdateAvailable && (
                              <span
                                className="ml-auto h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse"
                                title={`Panel update available${panelUpdateAvailable.version ? `: v${panelUpdateAvailable.version}` : ''}`}
                                aria-hidden
                              />
                            )}
                          </>
                        )}
                      </NavLink>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>

        {/* Footer */}
        <div className={cn('border-t border-border/30', sidebarCollapsed ? 'p-2 space-y-1.5' : 'px-3 py-2 space-y-1')}>
          {!sidebarCollapsed ? (
            <>
              <div className="flex items-center gap-2 text-[11px]">
                <ConnectionStatus />
                <AuthFooter />
              </div>
              <div className="flex items-center gap-2 text-[11px]">
                <span className="flex items-center gap-2">
                  {panelUpdateAvailable && (
                    <NavLink
                      to="/settings"
                      onClick={() => setMobileMenuOpen(false)}
                      className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider text-warning hover:bg-warning/20 transition-colors"
                      title={`Panel update available${panelUpdateAvailable.version ? `: v${panelUpdateAvailable.version}` : ''}. Open Panel Settings.`}
                    >
                      <span className="h-1.5 w-1.5 rounded-full bg-warning motion-safe:animate-pulse" />
                      Update
                    </NavLink>
                  )}
                  <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/55">
                    v{panelVersion || '—'}
                  </span>
                  <span className="h-3 w-px bg-border/40" aria-hidden />
                  <a
                    href="https://ko-fi.com/fpsacha"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground/70 hover:text-[#FF5E5B] transition-colors"
                    aria-label="Support on Ko-fi (opens in new tab)"
                    title="Buy me a coffee"
                  >
                    <Coffee className="h-3.5 w-3.5" />
                  </a>
                  <a
                    href="https://github.com/fpsacha/zomboid-control-panel"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground/70 hover:text-foreground transition-colors"
                    aria-label="GitHub repository (opens in new tab)"
                  >
                    <Github className="h-3.5 w-3.5" />
                  </a>
                  <button
                    onClick={() => setHelpOpen(true)}
                    className="text-muted-foreground/70 hover:text-foreground transition-colors"
                    aria-label="Keyboard shortcuts"
                    title="Keyboard shortcuts (?)"
                  >
                    <kbd className="inline-flex h-4 w-4 items-center justify-center rounded border border-border/40 text-[10px] font-mono leading-none">?</kbd>
                  </button>
                </span>
              </div>
            </>
          ) : (
            <div className="flex justify-center">
              <ConnectionStatus className="justify-center" />
            </div>
          )}
          {/* Collapse toggle */}
          <div className="hidden lg:block">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleSidebar}
                  className={cn(
                    'flex h-5 w-full items-center justify-center rounded text-muted-foreground/35 hover:text-muted-foreground transition-colors',
                    sidebarCollapsed && 'mx-auto w-8'
                  )}
                  aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                >
                  {sidebarCollapsed ? <PanelLeft className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
                </button>
              </TooltipTrigger>
              {sidebarCollapsed && <TooltipContent side="right">Expand sidebar</TooltipContent>}
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>
      </aside>

      {/* Main Content */}
      <main id="main-content" className="flex-1 overflow-auto pt-16 lg:pt-0">
        <div className="p-4 lg:p-8 max-w-7xl mx-auto">
          <SystemHealthBanner />
          {/* Server Update Banner — cockpit-style: vertical accent, mono micro-label, tabular build delta */}
          {updateInfo && updateInfo.updateAvailable && !updateDismissed && (
            <div
              role="status"
              className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border border-warning/35 bg-warning/[0.04] py-2 pl-3 pr-2 shadow-[inset_2px_0_0_hsl(var(--warning))]"
            >
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-warning" />
              <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
                <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-warning">
                  Server update
                </span>
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  New build on <span className="font-medium text-foreground">{updateInfo.installed.branch}</span> branch
                  {updateInfo.latest.description && (
                    <span className="text-muted-foreground/70"> · {updateInfo.latest.description}</span>
                  )}
                </span>
                <span className="font-mono text-[11px] tabular-nums text-foreground/85">
                  b{updateInfo.installed.buildId} <span className="text-muted-foreground/60">→</span> b{updateInfo.latest.buildId}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                  onClick={() => {
                    setUpdateDismissed(true)
                    const key = updateInfo && updateInfo.installed && updateInfo.latest
                      ? `updateBannerDismissed:${updateInfo.installed.buildId}->${updateInfo.latest.buildId}`
                      : null
                    if (key) localStorage.setItem(key, 'true')
                  }}
                >
                  Dismiss
                </Button>
                <Button
                  size="sm"
                  variant="warning"
                  className="h-7 gap-1.5 px-2.5 text-xs font-semibold"
                  onClick={() => navigate('/servers')}
                >
                  <RefreshCw className="h-3 w-3" />
                  Update server
                </Button>
              </div>
            </div>
          )}
          {children}
        </div>
      </main>
      <KeyboardShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} shortcuts={shortcuts} />
    </div>
  )
}
