import { describe, it, expect, beforeEach, vi } from "vitest";

// In-memory stand-ins so the real service logic (including bcrypt) runs
// without touching the panel database — same shape as recoveryCodes.test.js.
const settings = new Map();
const db = { data: { users: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
}));

const {
  default: authService,
  requirePermission,
  requireRole,
  DEFAULT_ROLE_PERMISSIONS,
  DEFAULT_ROLE,
  ROLES,
} = await import("../services/auth.js");

function admin(overrides = {}) {
  return {
    id: "admin-1",
    username: "owner",
    role: "admin",
    password: "unset",
    createdAt: "2024-01-01T00:00:00.000Z",
    tokenGen: 0,
    refreshSessions: [],
    ...overrides,
  };
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

// Drive a middleware the way Express would and report whether it passed.
async function runMiddleware(middleware, req) {
  const res = createResponse();
  let passed = false;
  await middleware(req, res, () => {
    passed = true;
  });
  return { passed, res };
}

beforeEach(async () => {
  settings.clear();
  db.data.users = [admin()];
  await authService.loadRolePermissions();
});

describe("createUser roles", () => {
  it("defaults new accounts to the least-privileged tier", async () => {
    const user = await authService.createUser("friend", "hunter2");
    expect(user.role).toBe(DEFAULT_ROLE);
    expect(DEFAULT_ROLE).toBe("viewer");
  });

  it("no longer hardcodes admin", async () => {
    await authService.createUser("friend", "hunter2");
    const created = db.data.users.find((u) => u.username === "friend");
    expect(created.role).not.toBe("admin");
  });

  it("honours an explicit role", async () => {
    const user = await authService.createUser("mod", "hunter2", "moderator");
    expect(user.role).toBe("moderator");
  });

  it("rejects an unknown role", async () => {
    await expect(
      authService.createUser("weird", "hunter2", "superuser"),
    ).rejects.toThrow(/Role must be one of/);
  });
});

describe("last-admin protection", () => {
  it("refuses to demote the only admin", async () => {
    await expect(
      authService.setUserRole("admin-1", "viewer"),
    ).rejects.toThrow(/last remaining admin/);
    expect(db.data.users[0].role).toBe("admin");
  });

  it("refuses to delete the only admin", async () => {
    await expect(authService.deleteUser("admin-1")).rejects.toThrow(
      /last remaining admin/,
    );
    expect(db.data.users).toHaveLength(1);
  });

  it("allows demotion once a second admin exists", async () => {
    db.data.users.push(admin({ id: "admin-2", username: "second" }));
    const result = await authService.setUserRole("admin-1", "moderator");
    expect(result.role).toBe("moderator");
  });

  it("bumps tokenGen on demotion so the old access token stops working", async () => {
    db.data.users.push(admin({ id: "admin-2", username: "second" }));
    await authService.setUserRole("admin-1", "viewer");
    expect(db.data.users[0].tokenGen).toBe(1);
    expect(db.data.users[0].refreshSessions).toEqual([]);
  });
});

describe("recovery no longer falls back to users[0]", () => {
  it("targets the OLDEST admin rather than array order", async () => {
    db.data.users = [
      admin({
        id: "admin-new",
        username: "newer",
        createdAt: "2025-06-01T00:00:00.000Z",
      }),
      admin({
        id: "admin-old",
        username: "older",
        createdAt: "2023-01-01T00:00:00.000Z",
      }),
    ];
    const result = await authService.resetPassword("brand-new-pass");
    expect(result.username).toBe("older");
  });

  it("throws instead of resetting a viewer when no admin exists", async () => {
    db.data.users = [
      {
        id: "viewer-1",
        username: "friend",
        role: "viewer",
        password: "unset",
        tokenGen: 0,
        refreshSessions: [],
      },
    ];
    await expect(authService.resetPassword("brand-new-pass")).rejects.toThrow(
      /No admin account exists/,
    );
    expect(db.data.users[0].password).toBe("unset");
  });

  it("can target a specific account when asked", async () => {
    db.data.users.push({
      id: "viewer-1",
      username: "friend",
      role: "viewer",
      password: "unset",
      tokenGen: 0,
      refreshSessions: [],
    });
    const result = await authService.resetPassword("brand-new-pass", "viewer-1");
    expect(result.username).toBe("friend");
    expect(db.data.users[0].password).toBe("unset");
  });

  it("refuses to mint recovery codes with no admin present", async () => {
    db.data.users = [
      {
        id: "viewer-1",
        username: "friend",
        role: "viewer",
        password: "unset",
        tokenGen: 0,
        refreshSessions: [],
      },
    ];
    await expect(authService.generateRecoveryCodes(3)).rejects.toThrow(
      /No admin account exists/,
    );
  });
});

describe("role permission table", () => {
  it("starts from the shipped defaults", async () => {
    expect(authService.getRolePermissions()).toEqual(DEFAULT_ROLE_PERMISSIONS);
  });

  it("persists an update and reloads it", async () => {
    await authService.updateRolePermissions({ "rcon.execute": "moderator" });
    expect(authService.getRolePermissions()["rcon.execute"]).toBe("moderator");

    await authService.loadRolePermissions();
    expect(authService.getRolePermissions()["rcon.execute"]).toBe("moderator");
  });

  it("leaves untouched capabilities at their default", async () => {
    await authService.updateRolePermissions({ "rcon.execute": "moderator" });
    expect(authService.getRolePermissions()["players.gm"]).toBe(
      DEFAULT_ROLE_PERMISSIONS["players.gm"],
    );
  });

  it("drops unknown capability keys and unknown tiers", async () => {
    await authService.updateRolePermissions({
      "not.a.capability": "admin",
      "players.gm": "wizard",
    });
    const perms = authService.getRolePermissions();
    expect(perms["not.a.capability"]).toBeUndefined();
    expect(perms["players.gm"]).toBe(DEFAULT_ROLE_PERMISSIONS["players.gm"]);
  });

  it("degrades a corrupt stored value to defaults instead of throwing", async () => {
    settings.set("rolePermissions", "{ not json");
    await authService.loadRolePermissions();
    expect(authService.getRolePermissions()).toEqual(DEFAULT_ROLE_PERMISSIONS);
  });

  it("rejects a non-object update", async () => {
    await expect(authService.updateRolePermissions(null)).rejects.toThrow(
      /Permissions object required/,
    );
  });
});

describe("requirePermission middleware", () => {
  it("throws at registration time for an unknown capability", () => {
    expect(() => requirePermission("players.fly")).toThrow(
      /Unknown permission capability/,
    );
  });

  it("denies a viewer a moderator-tier capability", async () => {
    const { passed, res } = await runMiddleware(
      requirePermission("players.moderate"),
      { user: { role: "viewer" } },
    );
    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("allows a moderator a moderator-tier capability", async () => {
    const { passed } = await runMiddleware(
      requirePermission("players.moderate"),
      { user: { role: "moderator" } },
    );
    expect(passed).toBe(true);
  });

  it("lets admin satisfy a moderator-tier capability by rank", async () => {
    const { passed } = await runMiddleware(
      requirePermission("players.moderate"),
      { user: { role: "admin" } },
    );
    expect(passed).toBe(true);
  });

  it("denies a moderator an admin-tier capability", async () => {
    const { passed, res } = await runMiddleware(
      requirePermission("rcon.execute"),
      { user: { role: "moderator" } },
    );
    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("fails closed on an unrecognised role", async () => {
    const { passed, res } = await runMiddleware(
      requirePermission("players.moderate"),
      { user: { role: "gm" } },
    );
    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("passes through when auth is disabled (no req.user)", async () => {
    const { passed } = await runMiddleware(
      requirePermission("rcon.execute"),
      {},
    );
    expect(passed).toBe(true);
  });

  it("reflects a runtime retune without re-registering the route", async () => {
    const middleware = requirePermission("world.environment");

    const before = await runMiddleware(middleware, {
      user: { role: "moderator" },
    });
    expect(before.passed).toBe(true);

    await authService.updateRolePermissions({ "world.environment": "admin" });

    const after = await runMiddleware(middleware, {
      user: { role: "moderator" },
    });
    expect(after.passed).toBe(false);
    expect(after.res.status).toHaveBeenCalledWith(403);
  });
});

describe("requireRole still matches exactly", () => {
  it("rejects a moderator from an admin-only route", async () => {
    const { passed, res } = await runMiddleware(requireRole("admin"), {
      user: { role: "moderator" },
    });
    expect(passed).toBe(false);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("admits an admin", async () => {
    const { passed } = await runMiddleware(requireRole("admin"), {
      user: { role: "admin" },
    });
    expect(passed).toBe(true);
  });
});

describe("role vocabulary", () => {
  it("is exactly viewer/moderator/admin, lowest first", () => {
    expect(ROLES).toEqual(["viewer", "moderator", "admin"]);
  });

  it("covers every capability the UI can retune", () => {
    expect(Object.keys(DEFAULT_ROLE_PERMISSIONS).sort()).toEqual([
      "chat.broadcast",
      "config.files",
      "mods.manage",
      "players.gm",
      "players.moderate",
      "rcon.execute",
      "scheduler.manage",
      "server.lifecycle",
      "server.save",
      "world.environment",
    ]);
  });

  it("keeps mod management and config file editing independent", async () => {
    expect(DEFAULT_ROLE_PERMISSIONS["mods.manage"]).toBe("admin");
    expect(DEFAULT_ROLE_PERMISSIONS["config.files"]).toBe("admin");

    // Handing out one must not hand out the other.
    await authService.updateRolePermissions({ "mods.manage": "moderator" });
    const perms = authService.getRolePermissions();
    expect(perms["mods.manage"]).toBe("moderator");
    expect(perms["config.files"]).toBe("admin");

    const modManager = requirePermission("mods.manage");
    const configEditor = requirePermission("config.files");
    const asModerator = { user: { role: "moderator" } };

    expect((await runMiddleware(modManager, asModerator)).passed).toBe(true);
    expect((await runMiddleware(configEditor, asModerator)).passed).toBe(false);
  });
});
