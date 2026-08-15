import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Eye,
  Loader2,
  Lock,
  RefreshCw,
  Shield,
  Trash2,
  User,
  UserPlus,
  Users,
} from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { PasswordInput } from "@/components/PasswordInput";
import { useAuth } from "@/contexts/AuthContext";
import { useConfirm } from "@/contexts/ConfirmContext";
import { ApiError, authApi, type PanelUser } from "@/lib/api";

interface FlashMessage {
  type: "success" | "error";
  text: string;
}

/** Lowest first — an admin implicitly satisfies anything set to moderator. */
const ROLE_TIERS = ["viewer", "moderator", "admin"] as const;
type RoleTier = (typeof ROLE_TIERS)[number];

/**
 * The capabilities the server resolves per request through
 * `requirePermission(key)`. Everything not listed here (mods, server files,
 * configuration, Discord credentials, backups, templates, install/wipe) is
 * hard-wired to admin on the server and is deliberately not editable.
 */
const CAPABILITIES: { key: string; label: string; desc: string }[] = [
  {
    key: "players.moderate",
    label: "Player moderation",
    desc: "Kick, ban, unban, whitelist, voice ban, notes",
  },
  {
    key: "players.gm",
    label: "Player GM powers",
    desc: "Teleport, heal, god mode, kill, give items, character import/export",
  },
  {
    key: "world.environment",
    label: "World & weather",
    desc: "Weather, climate, time, sound, zombies, visual effects",
  },
  {
    key: "chat.broadcast",
    label: "Broadcast & chat",
    desc: "Server messages, admin chat, alerts",
  },
  { key: "server.save", label: "Save world", desc: "Force a world save" },
  {
    key: "server.lifecycle",
    label: "Server lifecycle",
    desc: "Start, stop, force-stop and restart the game server",
  },
  {
    key: "scheduler.manage",
    label: "Scheduler",
    desc: "Create, edit and run scheduled tasks",
  },
  {
    key: "rcon.execute",
    label: "RCON console",
    desc: "Run arbitrary RCON commands",
  },
  {
    key: "mods.manage",
    label: "Mod manager",
    desc: "Install, remove and reorder Workshop mods, presets and collections",
  },
  {
    key: "config.files",
    label: "Server configuration",
    desc: "Edit the server's INI, sandbox vars, spawn points and regions",
  },
];

function InlineFeedback({
  message,
  className,
}: {
  message: FlashMessage | null;
  className?: string;
}) {
  if (!message) return null;

  return (
    <Alert
      variant={message.type === "error" ? "destructive" : "default"}
      className={className}
    >
      {message.type === "error" ? (
        <AlertCircle className="h-4 w-4" />
      ) : (
        <CheckCircle2 className="h-4 w-4" />
      )}
      <AlertTitle>{message.type === "error" ? "Error" : "Success"}</AlertTitle>
      <AlertDescription>{message.text}</AlertDescription>
    </Alert>
  );
}

/** The server answers 401/403 for every admin-only route. */
function isAccessDenied(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.status === 401 || error.status === 403)
  );
}

/**
 * The server refuses to delete or demote the last admin, and refuses
 * self-deletion, with a human-readable `error` string on a 400 — surface it
 * verbatim instead of a generic failure.
 */
function toMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function formatMoment(
  value: string | null,
  fallback: string,
  withTime: boolean,
): string {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return withTime ? parsed.toLocaleString() : parsed.toLocaleDateString();
}

function TierSelector({
  value,
  disabled,
  disabledReason,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  disabledReason?: string;
  onChange: (tier: RoleTier) => void;
}) {
  return (
    <div className="flex gap-1 shrink-0">
      {ROLE_TIERS.map((tier) => {
        const isActive = value === tier;
        const variant = isActive
          ? tier === "viewer"
            ? "default"
            : tier === "moderator"
              ? "secondary"
              : "destructive"
          : "ghost";
        const icons = {
          viewer: <Eye className="w-3 h-3" />,
          moderator: <Shield className="w-3 h-3" />,
          admin: <Lock className="w-3 h-3" />,
        };
        return (
          <Button
            key={tier}
            type="button"
            variant={variant}
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            disabled={disabled}
            title={disabled ? disabledReason : undefined}
            onClick={() => onChange(tier)}
          >
            {icons[tier]}
            <span className="hidden sm:inline capitalize">{tier}</span>
          </Button>
        );
      })}
    </div>
  );
}

export default function UsersAndRoles() {
  const { user, authEnabled, isLoading: authLoading } = useAuth();
  const confirm = useConfirm();
  const isAdmin = !authEnabled || user?.role === "admin";

  const [users, setUsers] = useState<PanelUser[]>([]);
  const [usersLoading, setUsersLoading] = useState(true);
  const [usersLocked, setUsersLocked] = useState(false);
  const [usersMessage, setUsersMessage] = useState<FlashMessage | null>(null);
  const [pendingUserId, setPendingUserId] = useState<string | null>(null);

  const [permissions, setPermissions] = useState<Record<string, string>>({});
  const [permissionsLoading, setPermissionsLoading] = useState(true);
  const [savingPermissions, setSavingPermissions] = useState(false);
  const [permissionsMessage, setPermissionsMessage] =
    useState<FlashMessage | null>(null);

  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newRole, setNewRole] = useState<RoleTier>("viewer");
  const [creating, setCreating] = useState(false);

  const loadUsers = useCallback(async () => {
    try {
      const { users: list } = await authApi.listUsers();
      setUsers(list);
      setUsersLocked(false);
    } catch (error) {
      if (isAccessDenied(error)) {
        setUsers([]);
        setUsersLocked(true);
      } else {
        setUsersMessage({
          type: "error",
          text: toMessage(error, "Failed to load panel accounts."),
        });
      }
    } finally {
      setUsersLoading(false);
    }
  }, []);

  const loadPermissions = useCallback(async () => {
    try {
      const { permissions: current } = await authApi.getPermissions();
      setPermissions(current);
    } catch (error) {
      setPermissionsMessage({
        type: "error",
        text: toMessage(error, "Failed to load capability permissions."),
      });
    } finally {
      setPermissionsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    void loadPermissions();
    if (isAdmin) {
      void loadUsers();
    } else {
      setUsers([]);
      setUsersLocked(true);
      setUsersLoading(false);
    }
  }, [authLoading, isAdmin, loadPermissions, loadUsers]);

  const canManageUsers = isAdmin && !usersLocked;
  const adminCount = users.filter((u) => u.role === "admin").length;

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (creating) return;
    const username = newUsername.trim();
    if (!username || !newPassword) return;

    setUsersMessage(null);
    setCreating(true);
    try {
      await authApi.createUser(username, newPassword, newRole);
      setNewUsername("");
      setNewPassword("");
      setNewRole("viewer");
      await loadUsers();
      setUsersMessage({
        type: "success",
        text: `Created ${username} as ${newRole}.`,
      });
    } catch (error) {
      setUsersMessage({
        type: "error",
        text: toMessage(error, "Failed to create the account."),
      });
    } finally {
      setCreating(false);
    }
  };

  const handleRoleChange = async (target: PanelUser, tier: RoleTier) => {
    if (target.role === tier) return;
    setUsersMessage(null);
    setPendingUserId(target.id);
    try {
      const { user: updated } = await authApi.setUserRole(target.id, tier);
      setUsers((prev) => prev.map((u) => (u.id === updated.id ? updated : u)));
      setUsersMessage({
        type: "success",
        text: `${updated.username} is now ${updated.role}.`,
      });
    } catch (error) {
      setUsersMessage({
        type: "error",
        text: toMessage(error, "Failed to change the account role."),
      });
    } finally {
      setPendingUserId(null);
    }
  };

  const handleDelete = async (target: PanelUser) => {
    const confirmed = await confirm({
      title: "Delete panel account",
      description: `Delete "${target.username}"? They lose access to the panel immediately. This cannot be undone.`,
      confirmLabel: "Delete account",
    });
    if (!confirmed) return;

    setUsersMessage(null);
    setPendingUserId(target.id);
    try {
      await authApi.deleteUser(target.id);
      setUsers((prev) => prev.filter((u) => u.id !== target.id));
      setUsersMessage({
        type: "success",
        text: `Deleted ${target.username}.`,
      });
    } catch (error) {
      setUsersMessage({
        type: "error",
        text: toMessage(error, "Failed to delete the account."),
      });
    } finally {
      setPendingUserId(null);
    }
  };

  const handleSavePermissions = async () => {
    try {
      setSavingPermissions(true);
      const { permissions: saved } =
        await authApi.updatePermissions(permissions);
      setPermissions(saved);
      setPermissionsMessage({
        type: "success",
        text: "Capability permissions saved. They apply to the next request — no restart needed.",
      });
    } catch (error: unknown) {
      const msg =
        error instanceof Error ? error.message : "Failed to save permissions";
      setPermissionsMessage({ type: "error", text: msg });
    } finally {
      setSavingPermissions(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Panel accounts */}
      <Card id="settings-users-accounts">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Users className="w-4 h-4 text-primary" />
            Panel accounts
          </CardTitle>
          <CardDescription>
            Who can sign in to this panel, and which role each account holds.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!isAdmin && (
            <Alert>
              <Lock className="h-4 w-4" />
              <AlertTitle>Administrators only</AlertTitle>
              <AlertDescription>
                Only an admin account can add, remove, or re-role panel
                accounts. The capability matrix below is shown read-only.
              </AlertDescription>
            </Alert>
          )}

          {isAdmin && usersLocked && !usersLoading && (
            <Alert>
              <Lock className="h-4 w-4" />
              <AlertTitle>Account management unavailable</AlertTitle>
              <AlertDescription>
                The server refused access to the account list. Sign in again
                with an admin account to manage panel accounts.
              </AlertDescription>
            </Alert>
          )}

          {isAdmin && usersLoading && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading accounts…
            </div>
          )}

          {canManageUsers && !usersLoading && (
            <>
              <div className="space-y-1.5">
                {users.map((account) => {
                  const isSelf = user?.id === account.id;
                  const isLastAdmin =
                    account.role === "admin" && adminCount <= 1;
                  const busy = pendingUserId === account.id;
                  const lockReason = isSelf
                    ? "You cannot change your own account here."
                    : isLastAdmin
                      ? "This is the last admin account."
                      : undefined;

                  return (
                    <div
                      key={account.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border/60 bg-muted/30 p-2.5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <div className="w-8 h-8 shrink-0 rounded-full bg-primary/10 flex items-center justify-center">
                          <User className="w-4 h-4 text-primary" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {account.username}
                            {isSelf && (
                              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                                (you)
                              </span>
                            )}
                          </p>
                          <p className="text-xs text-muted-foreground truncate">
                            Created{" "}
                            {formatMoment(account.createdAt, "unknown", false)}
                            {" · Last login "}
                            {formatMoment(account.lastLogin, "never", true)}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        {busy && (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                        )}
                        <TierSelector
                          value={account.role}
                          disabled={busy || isSelf || isLastAdmin}
                          disabledReason={lockReason}
                          onChange={(tier) => handleRoleChange(account, tier)}
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 gap-1 px-2 text-xs text-destructive hover:text-destructive"
                          disabled={busy || isSelf || isLastAdmin}
                          title={lockReason ?? `Delete ${account.username}`}
                          aria-label={`Delete ${account.username}`}
                          onClick={() => handleDelete(account)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    </div>
                  );
                })}

                {users.length === 0 && (
                  <p className="text-sm text-muted-foreground">
                    No panel accounts found.
                  </p>
                )}
              </div>

              {/* Add account */}
              <form
                onSubmit={handleCreate}
                className="space-y-3 rounded-lg border border-border/60 p-3"
              >
                <p className="text-sm font-medium">Add account</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="new-account-username">Username</Label>
                    <Input
                      id="new-account-username"
                      value={newUsername}
                      onChange={(e) => setNewUsername(e.target.value)}
                      placeholder="new-operator"
                      maxLength={64}
                      autoComplete="off"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="new-account-password">Password</Label>
                    <PasswordInput
                      id="new-account-password"
                      value={newPassword}
                      onChange={setNewPassword}
                      placeholder="At least 6 characters"
                      label="new account password"
                      maxLength={128}
                      autoComplete="new-password"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">Role</span>
                    <TierSelector
                      value={newRole}
                      disabled={creating}
                      onChange={setNewRole}
                    />
                  </div>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={
                      creating || !newUsername.trim() || newPassword.length === 0
                    }
                  >
                    {creating ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                        Adding...
                      </>
                    ) : (
                      <>
                        <UserPlus className="w-4 h-4 mr-2" /> Add account
                      </>
                    )}
                  </Button>
                </div>
              </form>
            </>
          )}

          <InlineFeedback message={usersMessage} className="mt-3" />
        </CardContent>
      </Card>

      {/* Capability permissions */}
      <Card id="settings-users-capabilities">
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2">
            <Shield className="w-4 h-4 text-primary" />
            Role capabilities
          </CardTitle>
          <CardDescription>
            Control the lowest role each capability requires. Changes apply
            immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Tier legend */}
          <div className="flex flex-wrap gap-3 text-sm mb-2">
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-primary" />
              <span className="font-medium">Viewer</span>
              <span className="text-muted-foreground">
                — any signed-in account
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground" />
              <span className="font-medium">Moderator</span>
              <span className="text-muted-foreground">
                — moderator or admin
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-destructive" />
              <span className="font-medium">Admin</span>
              <span className="text-muted-foreground">— admin only</span>
            </div>
          </div>

          <p className="text-sm text-muted-foreground">
            Capabilities not listed here — mods, server files, configuration,
            Discord credentials, backups, templates and server install/wipe —
            are always admin-only and cannot be changed.
          </p>

          {permissionsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading capabilities…
            </div>
          ) : (
            <>
              <div className="space-y-1.5">
                {CAPABILITIES.map((c) => {
                  const level = permissions[c.key];
                  return (
                    <div
                      key={c.key}
                      className="flex items-center justify-between rounded-lg border border-border/60 bg-muted/30 p-2.5"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <code className="text-sm font-semibold shrink-0">
                          {c.label}
                        </code>
                        <span className="text-sm text-muted-foreground truncate hidden sm:inline">
                          {c.desc}
                        </span>
                      </div>
                      <TierSelector
                        value={level ?? ""}
                        disabled={!isAdmin}
                        disabledReason="Only an admin can change capability permissions."
                        onChange={(tier) =>
                          setPermissions((prev) => ({
                            ...prev,
                            [c.key]: tier,
                          }))
                        }
                      />
                    </div>
                  );
                })}
              </div>

              {isAdmin && (
                <div className="flex justify-end pt-2">
                  <Button
                    type="button"
                    onClick={handleSavePermissions}
                    disabled={savingPermissions}
                  >
                    {savingPermissions ? (
                      <>
                        <RefreshCw className="w-4 h-4 mr-2 animate-spin" />{" "}
                        Saving...
                      </>
                    ) : (
                      "Save Permissions"
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
          <InlineFeedback message={permissionsMessage} className="mt-3" />
        </CardContent>
      </Card>
    </div>
  );
}
