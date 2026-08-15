import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn(),
  updateScheduledTask: vi.fn(),
  getServer: vi.fn(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  logPlayerAction: vi.fn().mockResolvedValue(),
  recordPlayerSession: vi.fn().mockResolvedValue(),
}));

const { Scheduler } = await import("../services/scheduler.js");
const { getScheduledTasks } = await import("../database/init.js");
const { default: router } = await import("../routes/scheduler.js");

function makeScheduler() {
  const rconService = {
    connected: true,
    execute: vi.fn().mockResolvedValue({ success: true }),
    save: vi.fn().mockResolvedValue({ success: true }),
    serverMessage: vi.fn().mockResolvedValue({ success: true }),
  };
  const serverManager = { _serverId: null };
  const scheduler = new Scheduler(rconService, serverManager);
  return { scheduler, rconService, serverManager };
}

// These assert runTaskNow() — the dispatch a cron fire AND the manual
// "run now" route now share — routes every task type to its real handler
// instead of shelling task.command straight to RCON.
describe("Scheduler.runTaskNow command dispatch", () => {
  it("routes 'restart' through performRestart, not raw RCON", async () => {
    const { scheduler, rconService } = makeScheduler();
    scheduler.performRestart = vi.fn().mockResolvedValue({ success: true });

    await scheduler.runTaskNow({ id: 1, name: "Restart", command: "restart" });

    expect(scheduler.performRestart).toHaveBeenCalledWith(null, {
      rconService,
      serverManager: expect.any(Object),
    });
    expect(rconService.execute).not.toHaveBeenCalledWith("restart", expect.anything());
  });

  it("routes 'save' through rconService.save()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 2, name: "Save", command: "save" });

    expect(rconService.save).toHaveBeenCalledWith({ skipLog: true });
  });

  it("routes 'servermsg <text>' through rconService.serverMessage()", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({
      id: 3,
      name: "Broadcast",
      command: "servermsg Server restarting soon",
    });

    expect(rconService.serverMessage).toHaveBeenCalledWith(
      "Server restarting soon",
      { skipLog: true },
    );
  });

  it("routes 'bridge:<action>' through executeBridgeAction()", async () => {
    const { scheduler } = makeScheduler();
    scheduler.executeBridgeAction = vi.fn().mockResolvedValue();

    await scheduler.runTaskNow({
      id: 4,
      name: "Storm",
      command: "bridge:triggerStorm",
    });

    expect(scheduler.executeBridgeAction).toHaveBeenCalledWith(
      "bridge:triggerStorm",
    );
  });

  it("falls back to a raw RCON command for anything else", async () => {
    const { scheduler, rconService } = makeScheduler();

    await scheduler.runTaskNow({ id: 5, name: "Players", command: "players" });

    expect(rconService.execute).toHaveBeenCalledWith("players", {
      skipLog: true,
    });
  });
});

function getRunNowHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id/run" && entry.route.methods.post,
  );
  // The first stack entry is now an authorization middleware; these tests
  // target the business-logic handler, so take the last one. Authorization
  // itself is covered by the dedicated role-rejection suites.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function getUpdateHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === "/tasks/:id" && entry.route.methods.put,
  );
  // Same authorization middleware as above: skip it and take the handler.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe("POST /api/scheduler/tasks/:id/run", () => {
  let runTaskNow;

  beforeEach(() => {
    runTaskNow = vi.fn().mockResolvedValue();
    getScheduledTasks.mockReset();
  });

  it("triggers the matching task through scheduler.runTaskNow()", async () => {
    const task = { id: 7, name: "Restart", command: "restart" };
    getScheduledTasks.mockResolvedValue([task]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()({ app, params: { id: "7" } }, response);

    expect(runTaskNow).toHaveBeenCalledWith(task);
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("returns 404 for a task id that doesn't exist", async () => {
    getScheduledTasks.mockResolvedValue([]);
    const app = { get: vi.fn().mockReturnValue({ runTaskNow }) };
    const response = createResponse();

    await getRunNowHandler()({ app, params: { id: "999" } }, response);

    expect(runTaskNow).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(404);
  });
});

describe("PUT /api/scheduler/tasks/:id", () => {
  it("keeps an enabled task scheduled when enabled is omitted", async () => {
    const { updateScheduledTask } = await import("../database/init.js");
    const scheduleTask = vi.fn();
    const cancelTask = vi.fn();
    updateScheduledTask.mockResolvedValue({
      id: 8,
      name: "Renamed task",
      cron_expression: "0 * * * *",
      command: "save",
      enabled: 1,
      server_id: null,
    });
    const response = createResponse();

    await getUpdateHandler()(
      {
        params: { id: "8" },
        body: { name: "Renamed task" },
        app: { get: () => ({ scheduleTask, cancelTask }) },
      },
      response,
    );

    expect(scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({ id: 8, enabled: 1 }),
    );
    expect(cancelTask).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: true }),
    );
  });

  it("rejects stringified enabled values instead of treating false as true", async () => {
    const { updateScheduledTask } = await import("../database/init.js");
    updateScheduledTask.mockClear();
    const response = createResponse();

    await getUpdateHandler()(
      {
        params: { id: "8" },
        body: { enabled: "false" },
        app: { get: () => ({ scheduleTask: vi.fn(), cancelTask: vi.fn() }) },
      },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(400);
    expect(updateScheduledTask).not.toHaveBeenCalled();
  });
});
