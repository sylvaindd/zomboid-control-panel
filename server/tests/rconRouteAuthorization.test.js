import { beforeEach, describe, expect, it, vi } from "vitest";

// Real auth service + real router: this exercises requirePermission through an
// actual Express router stack, not a stand-in.
const settings = new Map();
const db = { data: { users: [] } };

vi.mock("../database/init.js", () => ({
  getSetting: async (key) => settings.get(key) ?? null,
  setSetting: async (key, value) => {
    settings.set(key, value);
  },
  getDb: async () => db,
  commitNow: async () => {},
  getCommandHistory: vi.fn(async () => []),
}));

vi.mock("../services/rcon.js", () => ({
  testRconConnection: vi.fn(async () => ({ success: true })),
}));

const { default: authService } = await import("../services/auth.js");
const { default: router } = await import("../routes/rcon.js");

const execute = vi.fn(async () => ({ success: true, response: "ok" }));

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function createRequest(role, body = { command: "players" }) {
  return {
    body,
    user: role ? { role, userId: "u1", username: role } : undefined,
    app: {
      get: (key) => {
        if (key === "rconService") return { execute };
        return null;
      },
    },
  };
}

async function runRoute(routePath, method, request, response) {
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index += 1;
    if (error) throw error;
    if (index < handlers.length) {
      await handlers[index](request, response, next);
    }
  };
  await next();
}

describe("POST /api/rcon/execute authorization", () => {
  beforeEach(async () => {
    settings.clear();
    execute.mockClear();
    db.data.users = [];
    await authService.loadRolePermissions();
  });

  it("rejects a viewer", async () => {
    const response = createResponse();
    await runRoute("/execute", "post", createRequest("viewer"), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a moderator by default — rcon.execute ships as admin-only", async () => {
    const response = createResponse();
    await runRoute("/execute", "post", createRequest("moderator"), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("admits an admin", async () => {
    const response = createResponse();
    await runRoute("/execute", "post", createRequest("admin"), response);

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(execute).toHaveBeenCalledWith("players");
  });

  it("admits a moderator once an admin lowers the tier from the UI", async () => {
    await authService.updateRolePermissions({ "rcon.execute": "moderator" });

    const response = createResponse();
    await runRoute("/execute", "post", createRequest("moderator"), response);

    expect(response.status).not.toHaveBeenCalledWith(403);
    expect(execute).toHaveBeenCalledWith("players");
  });

  it("keeps rejecting a viewer after that same change", async () => {
    await authService.updateRolePermissions({ "rcon.execute": "moderator" });

    const response = createResponse();
    await runRoute("/execute", "post", createRequest("viewer"), response);

    expect(response.status).toHaveBeenCalledWith(403);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("RCON connection management stays admin-only", () => {
  beforeEach(async () => {
    settings.clear();
    await authService.loadRolePermissions();
  });

  // /connect, /test and /disconnect rewrite stored RCON credentials, so they
  // use requireRole("admin") and must NOT follow the rcon.execute setting.
  it("rejects a moderator from /test even when rcon.execute is lowered", async () => {
    await authService.updateRolePermissions({ "rcon.execute": "moderator" });

    const response = createResponse();
    await runRoute(
      "/test",
      "post",
      {
        body: { host: "127.0.0.1", port: 27015, password: "x" },
        user: { role: "moderator" },
        app: { get: () => null },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
  });

  it("rejects a moderator from /disconnect", async () => {
    const response = createResponse();
    await runRoute(
      "/disconnect",
      "post",
      { body: {}, user: { role: "moderator" }, app: { get: () => null } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(403);
  });
});
