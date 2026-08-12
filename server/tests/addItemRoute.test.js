import { beforeEach, describe, expect, it, vi } from "vitest";

const logPlayerAction = vi.fn();
const deletePlayerNote = vi.fn();

vi.mock("../database/init.js", () => ({
  logPlayerAction,
  getPlayerLogs: vi.fn(),
  getPlayerNotes: vi.fn(),
  getPlayerNote: vi.fn(),
  upsertPlayerNote: vi.fn(),
  deletePlayerNote,
  getPlayerStats: vi.fn(),
  getPlayerStat: vi.fn(),
  getSteamIdBans: vi.fn(),
  addSteamIdBan: vi.fn(),
  removeSteamIdBan: vi.fn(),
}));

const { default: router, normalizePlayerLogLimit } = await import(
  "../routes/players.js"
);

function createResponse() {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

function getHandler(path, method = "post") {
  const layer = router.stack.find(
    (entry) => entry.route?.path === path && entry.route.methods[method],
  );
  // The first stack entry is now an authorization middleware; these tests
  // target the business-logic handler, so take the last one. Authorization
  // itself is covered by the dedicated role-rejection suites.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

const addItem = vi.fn();

function createRequest(body) {
  return {
    body,
    app: { get: () => ({ addItem }) },
  };
}

async function giveItem(item) {
  const response = createResponse();
  await getHandler("/add-item")(
    createRequest({ username: "Tester", item, count: 1 }),
    response,
  );
  return response;
}

describe("POST /api/players/add-item item ID validation", () => {
  beforeEach(() => {
    addItem.mockReset();
    addItem.mockResolvedValue({ success: true });
    logPlayerAction.mockReset();
  });

  it.each([
    "Base.556Clip",
    "Base.3030Bullets",
    "Base.308Box",
    "Base.3rdGenChevyCKseriesBumperFront0",
    "Base.69fordMustangFenderFrame",
  ])("accepts item IDs whose name starts with a digit (%s)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).toHaveBeenCalledWith("Tester", item, 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  it.each([
    "MarzGuns.M&P_Suppressor",
    "MarzGuns.LRX-7_Laser",
    "Example.Item#Variant+2.0",
  ])("accepts documented punctuation in item IDs (%s)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).toHaveBeenCalledWith("Tester", item, 1);
    expect(response.status).not.toHaveBeenCalledWith(400);
  });

  it.each([
    'Base.Axe" ',
    "Base.Axe\\",
    "Base.Axe Base.Nails",
    "NoDotHere",
    "Base.",
    ".Axe",
  ])("rejects malformed or injection-prone IDs (%j)", async (item) => {
    const response = await giveItem(item);

    expect(addItem).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(400);
  });
});

describe("DELETE /api/players/notes/:playerName", () => {
  it("returns 404 when the note did not exist", async () => {
    deletePlayerNote.mockResolvedValue(false);
    const response = createResponse();

    await getHandler("/notes/:playerName", "delete")(
      { params: { playerName: "MissingPlayer" } },
      response,
    );

    expect(response.status).toHaveBeenCalledWith(404);
    expect(response.json).toHaveBeenCalledWith({
      success: false,
      error: "Player note not found",
    });
  });
});

describe("player activity limit normalization", () => {
  it.each([
    [undefined, 100],
    ["not-a-number", 100],
    ["-1", 100],
    ["0", 100],
    ["200", 200],
    ["9999", 500],
  ])("normalizes %j to %d rows", (input, expected) => {
    expect(normalizePlayerLogLimit(input)).toBe(expected);
  });
});
