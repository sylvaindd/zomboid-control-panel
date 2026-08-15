import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Chunks");
import {
  getSetting,
  setSetting,
  getActiveServer,
  updateServer,
} from "../database/init.js";
import { sanitizeError } from "../utils/sanitize.js";
import { requireRole } from "../services/auth.js";
import { deleteVehiclesInBoxes } from "../utils/vehiclesDb.js";
import { confineToRoots } from "../utils/browseRoots.js";
import {
  normalizeUserPath,
  getCandidateZomboidPaths,
  invalidateCandidatePathsCache,
  inspectZomboidPath,
} from "../utils/zomboidPaths.js";

// Re-export for tests / other modules that still pull these from chunks.js.
export { normalizeUserPath, getCandidateZomboidPaths };

const router = express.Router();

export async function copyChunkBackup(sourcePath, destinationPath, exclusive = false) {
  try {
    await fs.promises.copyFile(
      sourcePath,
      destinationPath,
      exclusive ? fs.constants.COPYFILE_EXCL : 0,
    );
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

// B42: 1 cell = 32×32 chunks (256×256 tiles, 8 tiles/chunk).
// B41: 1 cell = 30×30 chunks (300×300 tiles, 10 tiles/chunk).
function cellDivisorFor(isB42) {
  return isB42 ? 32 : 30;
}
function tilesPerChunkFor(isB42) {
  return isB42 ? 8 : 10;
}

// Filesystem-based B42 detection. Much more reliable than inferring from a
// filename pattern because selections can be chunkdata-only (no `map/X/Y.bin`
// path, which would falsely look like B41). Order:
//   1. map/ contains numeric X subdirectories → B42 layout
//   2. B42 indicator files in save root (WorldDictionary.bin etc)
//   3. fall back to flat B41 layout
function detectSaveIsB42Sync(savePath) {
  try {
    const mapPath = path.join(savePath, "map");
    if (fs.existsSync(mapPath)) {
      const entries = fs.readdirSync(mapPath, { withFileTypes: true });
      if (entries.some((e) => e.isDirectory() && /^\d+$/.test(e.name)))
        return true;
    }
  } catch {
    /* ignore */
  }
  const b42Indicators = [
    "WorldDictionary.bin",
    "global_mod_data.bin",
    "entity_data.bin",
  ];
  return b42Indicators.some((f) => {
    try {
      return fs.existsSync(path.join(savePath, f));
    } catch {
      return false;
    }
  });
}

// Given the set of cells touched by a chunk-deletion pass, determine which
// cells are now FULLY empty (no surviving chunk files anywhere in the cell's
// chunk range) and delete the per-cell auxiliary files (chunkdata, zpop,
// metagrid, apop). If any chunk survives in the cell we leave the cell files
// intact — deleting them nukes state for up to 1023 neighbouring chunks and
// is what made vehicles, zombies and loot "come back" in older builds.
//
// Only handles the B42 map/X/Y.bin layout. For B41 flat layouts, cell files
// typically don't exist or aren't used the same way — we leave them alone to
// avoid clobbering unrelated saves.
//
// If backupPath is provided, each aux file is copied into it before deletion
// so a restore can rebuild the cell exactly. Without this, a "restore from
// backup" leaves the save with chunk files present but no cell metadata —
// PZ would regenerate the cell partially and we'd get inconsistent state.
async function cleanupEmptyCellFiles(
  savePath,
  touchedCells,
  isB42,
  backupPath = null,
) {
  if (!isB42 || touchedCells.size === 0) return { removed: [] };
  const divisor = cellDivisorFor(true);
  const mapPath = path.join(savePath, "map");
  const removed = [];

  for (const key of touchedCells) {
    const [cellX, cellY] = key.split(",").map(Number);
    if (!Number.isInteger(cellX) || !Number.isInteger(cellY)) continue;

    // Check survivors: scan map/{X}/ for any *.bin whose Y falls in the cell's
    // chunk range [cellY*divisor, cellY*divisor+divisor).
    const minChunkX = cellX * divisor;
    const maxChunkX = minChunkX + divisor - 1;
    const minChunkY = cellY * divisor;
    const maxChunkY = minChunkY + divisor - 1;

    let hasSurvivor = false;
    for (let cx = minChunkX; cx <= maxChunkX && !hasSurvivor; cx++) {
      const xDir = path.join(mapPath, String(cx));
      let entries;
      try {
        entries = await fs.promises.readdir(xDir);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        // On unexpected errors, assume survivor to stay safe.
        hasSurvivor = true;
        break;
      }
      for (const name of entries) {
        const m = name.match(/^(\d+)\.bin$/);
        if (!m) continue;
        const y = parseInt(m[1], 10);
        if (y >= minChunkY && y <= maxChunkY) {
          hasSurvivor = true;
          break;
        }
      }
    }

    if (hasSurvivor) continue;

    // Cell is empty on disk — safe to remove per-cell auxiliary files.
    const cellFiles = [
      ["chunkdata", `chunkdata_${cellX}_${cellY}.bin`],
      ["zpop", `zpop_${cellX}_${cellY}.bin`],
      ["metagrid", `metacell_${cellX}_${cellY}.bin`],
      ["apop", `apop_${cellX}_${cellY}.bin`],
    ];
    for (const [folder, file] of cellFiles) {
      const full = path.join(savePath, folder, file);
      try {
        // Back up before deletion if a backup folder was passed. Nested under
        // cellaux/ so the restore script can distinguish these from chunk
        // backups (which live at the top level of backupPath).
        if (backupPath) {
          const cellAuxDir = path.join(backupPath, "cellaux", folder);
          await fs.promises.mkdir(cellAuxDir, { recursive: true });
          await copyChunkBackup(full, path.join(cellAuxDir, file));
        }
        await fs.promises.unlink(full);
        removed.push(`${folder}/${file}`);
      } catch (e) {
        if (e.code !== "ENOENT") {
          log.debug(
            `Failed to delete cell file ${folder}/${file}: ${e.message}`,
          );
        }
      }
    }
  }
  return { removed };
}

// Block all chunk operations for remote servers (no local filesystem access)
router.use(async (req, res, next) => {
  try {
    const activeServer = await getActiveServer();
    if (activeServer?.isRemote) {
      return res
        .status(400)
        .json({
          error:
            "Map cleanup is not available for remote servers. The server filesystem is not accessible from this panel.",
        });
    }
    next();
  } catch (err) {
    next(err);
  }
});

// Helper: Get zomboidDataPath from active server or legacy settings
async function getZomboidDataPath() {
  // First try active server (multi-server support)
  const activeServer = await getActiveServer();
  if (activeServer?.zomboidDataPath) {
    return normalizeUserPath(activeServer.zomboidDataPath);
  }

  // Fallback to legacy settings
  const legacyPath = await getSetting("zomboidDataPath");
  return normalizeUserPath(legacyPath) || null;
}

function resolveSavesPath(zomboidDataPath) {
  let savesPath = path.join(zomboidDataPath, "Saves", "Multiplayer");

  if (!fs.existsSync(savesPath)) {
    const basename = path.basename(zomboidDataPath);
    const parentDir = path.dirname(zomboidDataPath);
    const parentBase = path.basename(parentDir);
    const grandparentBase = path.basename(path.dirname(parentDir));
    if (basename === "Multiplayer" && parentBase === "Saves") {
      // User pointed at .../Saves/Multiplayer directly
      savesPath = zomboidDataPath;
    } else if (basename === "Saves") {
      // User pointed at .../Saves — append Multiplayer
      savesPath = path.join(zomboidDataPath, "Multiplayer");
    } else if (parentBase === "Multiplayer" && grandparentBase === "Saves") {
      // User pointed at an INDIVIDUAL save directory (.../Saves/Multiplayer/<savename>).
      // Walk up one level so we list saves from the right parent. Without this we
      // double-append and log: "Saves path not found: .../<savename>/Saves/Multiplayer".
      savesPath = parentDir;
    }
  }

  return savesPath;
}

function resolveCustomOrDefaultDataPath(customPath) {
  if (!customPath) return null;
  const cleaned = normalizeUserPath(customPath);
  if (!cleaned) return null;
  const normalized = path.resolve(cleaned);
  if (!fs.existsSync(normalized)) {
    const error = new Error(
      `Custom path does not exist: ${normalized}. ` +
        `Check for typos and verify the panel has read access to this folder.`,
    );
    error.statusCode = 400;
    error.details = { reason: "not-found", tried: normalized };
    throw error;
  }
  try {
    if (!fs.statSync(normalized).isDirectory()) {
      const error = new Error(`Custom path is not a directory: ${normalized}`);
      error.statusCode = 400;
      error.details = { reason: "not-a-directory", tried: normalized };
      throw error;
    }
  } catch (e) {
    if (e.statusCode) throw e;
    const error = new Error(
      `Could not read custom path (${e.code || "error"}): ${normalized}`,
    );
    error.statusCode = 400;
    error.details = {
      reason: "stat-failed",
      tried: normalized,
      errorCode: e.code,
    };
    throw error;
  }

  const verdict = inspectZomboidPath(normalized);
  if (verdict.ok) return normalized;

  // Structured rejection — caller surfaces these in the debug payload so the
  // frontend can render targeted remediation (parent suggestion, "this is the
  // server install", etc.) instead of just a generic "doesn't look like…".
  if (verdict.reason === "install-folder") {
    log.warn(
      `[ChunkCleaner] Rejected custom path (server install folder): ${normalized}`,
    );
    const error = new Error(
      "This folder looks like a Project Zomboid server install (it contains " +
        "ProjectZomboid64.exe / .json or similar). " +
        "Point at the user data folder instead — usually " +
        (process.platform === "win32"
          ? "C:\\Users\\<you>\\Zomboid"
          : "~/Zomboid") +
        " — not the server folder.",
    );
    error.statusCode = 400;
    error.details = {
      reason: "install-folder",
      tried: normalized,
      checks: verdict.checks,
    };
    throw error;
  }

  // No Zomboid markers anywhere. If they pointed at .../Saves or
  // .../Multiplayer (common copy-paste mistake), suggest the parent.
  log.warn(
    `[ChunkCleaner] Rejected custom path (no Zomboid markers found): ${normalized}`,
  );
  let msg =
    "Path does not appear to be a Zomboid data directory. " +
    "Point at your Zomboid data folder (the one containing Saves/), " +
    "a Saves/Multiplayer folder, or an individual save directory.";
  if (verdict.parentSuggestion) {
    msg += ` Did you mean ${verdict.parentSuggestion}?`;
  }
  const error = new Error(msg);
  error.statusCode = 403;
  error.details = {
    reason: "no-zomboid-markers",
    tried: normalized,
    checks: verdict.checks,
    parentSuggestion: verdict.parentSuggestion || null,
  };
  throw error;
}

// Get list of available saves
router.get("/saves", async (req, res) => {
  try {
    // Support custom path override from query parameter
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    let zomboidDataPath;
    // Tracks whether we silently selected a candidate path when none was
    // configured — surfaced to the UI so the user can confirm/persist it.
    let autoPickedFrom = null;
    if (customPath) {
      // Validate custom path exists and is a directory
      const normalized = resolveCustomOrDefaultDataPath(customPath);
      zomboidDataPath = normalized;
      log.info(`[ChunkCleaner] Using custom path: ${normalized}`);
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      // No path configured — before bouncing to an error, try to auto-pick
      // a candidate that has saves on disk. This is the common case for a
      // fresh install where the panel was started before any server was
      // configured. Pick only if exactly one candidate has saves to avoid
      // silently choosing the wrong one when multiple installs exist.
      const candidates = getCandidateZomboidPaths();
      const withSaves = candidates.filter((c) => c.hasSaves);
      if (withSaves.length === 1) {
        zomboidDataPath = withSaves[0].path;
        autoPickedFrom = zomboidDataPath;
        log.info(
          `[ChunkCleaner] Auto-picked Zomboid data path: ${zomboidDataPath}`,
        );
      } else {
        return res.status(400).json({
          error:
            "Zomboid data path not set. " +
            "Configure a server in Settings → Servers, or use the Custom path field below to point at your Zomboid folder.",
          debug: {
            zomboidDataPath: null,
            savesPath: null,
            exists: false,
            usedCustomPath: false,
            hint:
              withSaves.length > 1
                ? `Found ${withSaves.length} candidate folders with saves — pick one below.`
                : "No Zomboid data folder is configured for this panel.",
            suggestedPaths: candidates,
          },
        });
      }
    }

    // Try the standard path first, then check if the path IS a Saves/Multiplayer dir directly
    let savesPath = resolveSavesPath(zomboidDataPath);
    const attempted = [savesPath];

    if (!fs.existsSync(savesPath)) {
      // Maybe the user pointed directly to Saves/Multiplayer
      const basename = path.basename(zomboidDataPath);
      const parentDir = path.dirname(zomboidDataPath);
      const parentBase = path.basename(parentDir);
      const grandparentBase = path.basename(path.dirname(parentDir));
      if (basename === "Multiplayer" && parentBase === "Saves") {
        savesPath = zomboidDataPath;
        log.info(`[ChunkCleaner] Path points directly to Saves/Multiplayer`);
      } else if (basename === "Saves") {
        savesPath = path.join(zomboidDataPath, "Multiplayer");
        attempted.push(savesPath);
        log.info(`[ChunkCleaner] Path points directly to Saves dir`);
      } else if (parentBase === "Multiplayer" && grandparentBase === "Saves") {
        // Individual save directory — walk up to list siblings
        savesPath = parentDir;
        attempted.push(savesPath);
        log.info(
          `[ChunkCleaner] Path points to an individual save; using parent Saves/Multiplayer`,
        );
      } else {
        log.warn(`[ChunkCleaner] Saves path not found: ${savesPath}`);
        log.info(`[ChunkCleaner] zomboidDataPath: ${zomboidDataPath}`);
        return res.json({
          saves: [],
          debug: {
            zomboidDataPath,
            savesPath,
            exists: false,
            usedCustomPath: Boolean(customPath),
            attempted,
            hint:
              `Looked for ${path.join("Saves", "Multiplayer")} inside the data folder but didn't find it. ` +
              `Has this server ever been started, or is the data path pointing at the wrong place?`,
            suggestedPaths: customPath ? [] : getCandidateZomboidPaths(),
          },
        });
      }
    }

    if (!fs.existsSync(savesPath)) {
      log.warn(
        `[ChunkCleaner] Resolved saves path does not exist: ${savesPath}`,
      );
      return res.json({
        saves: [],
        debug: {
          zomboidDataPath,
          savesPath,
          exists: false,
          usedCustomPath: Boolean(customPath),
          attempted,
          hint: `The resolved saves folder doesn't exist on disk. Start the server once to create it, or pick a different data path.`,
          suggestedPaths: customPath ? [] : getCandidateZomboidPaths(),
        },
      });
    }

    log.info(`[ChunkCleaner] Listing saves from: ${savesPath}`);

    let entries;
    try {
      entries = await fs.promises.readdir(savesPath, { withFileTypes: true });
    } catch (e) {
      log.warn(
        `[ChunkCleaner] Failed to read saves dir ${savesPath}: ${e.message}`,
      );
      const code = e.code || "EREAD";
      const hint =
        code === "EACCES" || code === "EPERM"
          ? `Panel does not have permission to read this folder. On Linux, check that the panel runs as the same user that owns the Zomboid folder (or fix permissions with chown/chmod).`
          : `Could not read the saves folder (${code}).`;
      return res.status(403).json({
        error: hint,
        debug: {
          zomboidDataPath,
          savesPath,
          exists: true,
          usedCustomPath: Boolean(customPath),
          attempted,
          hint,
          errorCode: code,
        },
      });
    }
    // Exclude our own `backups` folder. Chunk/region deletions write backups
    // to `<zomboidDataPath>/backups`. When the user points the data path
    // directly at `Saves/Multiplayer` (a supported config), that backups
    // folder lands inside the saves listing and would otherwise show up as a
    // fake, un-loadable "save". It is never a real PZ multiplayer save.
    const directories = entries.filter(
      (d) => d.isDirectory() && d.name.toLowerCase() !== "backups",
    );

    log.info(
      `[ChunkCleaner] Found ${directories.length} save directories: ${directories.map((d) => d.name).join(", ")}`,
    );

    const saves = await Promise.all(
      directories.map(async (d) => {
        const savePath = path.join(savesPath, d.name);
        const stats = await fs.promises.stat(savePath);

        // Count chunk files (uses recursive count for B42's subdirectory structure)
        // Also check save root for B41 flat chunk files
        let chunkCount = 0;
        const mapPath = path.join(savePath, "map");
        if (fs.existsSync(mapPath)) {
          chunkCount = await countFiles(mapPath);
        }
        if (chunkCount === 0) {
          // B41 fallback: count map_X_Y.bin files in save root
          const B41_CHUNK_REGEX = /^map_\d+_\d+\.bin$/i;
          try {
            const rootEntries = await fs.promises.readdir(savePath);
            chunkCount = rootEntries.filter((f) =>
              B41_CHUNK_REGEX.test(f),
            ).length;
          } catch (e) {
            log.debug(
              `B41 chunk count fallback failed for ${savePath}: ${e.message}`,
            );
          }
        }

        // Get save size
        const size = await getDirSize(savePath);

        return {
          name: d.name,
          modified: stats.mtime,
          chunkCount,
          size,
          sizeFormatted: formatBytes(size),
        };
      }),
    );

    res.json({
      saves,
      debug: {
        zomboidDataPath,
        savesPath,
        exists: true,
        usedCustomPath: Boolean(customPath),
        autoPicked: autoPickedFrom,
        hint:
          saves.length === 0
            ? `Saves folder exists but contains no save directories. Start the server once, or pick a different folder.`
            : null,
        suggestedPaths:
          saves.length === 0 && !customPath ? getCandidateZomboidPaths() : [],
      },
    });
  } catch (error) {
    // User-input rejections (400/403 with structured details) are not panel
    // bugs — log them at WARN so alerting/email pipelines don't fire on every
    // typo in the path field. Real failures (no statusCode = 500) stay ERROR.
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError) {
      log.warn(`Get saves rejected (${error.statusCode}): ${error.message}`);
    } else {
      log.error(`Failed to get saves: ${error.message}`);
    }
    // Forward structured rejection details (reason, checks, parentSuggestion)
    // so the frontend empty-state panel can render targeted remediation.
    const payload = { error: sanitizeError(error.message) };
    if (error.details) {
      payload.debug = {
        zomboidDataPath: null,
        savesPath: null,
        exists: false,
        usedCustomPath: true,
        hint: error.message,
        rejection: error.details,
        suggestedPaths: getCandidateZomboidPaths(),
      };
    }
    res.status(error.statusCode || 500).json(payload);
  }
});

// List common Zomboid path candidates so the UI can present clickable
// suggestions when the panel can't find a data folder on its own.
router.get("/suggested-paths", async (req, res) => {
  try {
    // Allow the UI to bust the 30s cache after the user creates/moves a
    // folder (?refresh=1) so suggestions update without a panel restart.
    if (req?.query?.refresh) invalidateCandidatePathsCache();
    res.json({
      candidates: getCandidateZomboidPaths(),
      platform: process.platform,
    });
  } catch (error) {
    log.error(`Failed to enumerate suggested paths: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Persist a custom path as the panel's configured Zomboid data folder.
// Writes to the active server's `zomboidDataPath` when one exists, otherwise
// to the legacy flat setting. The path is validated with the same rules as
// the /saves customPath query parameter so users can't smuggle in arbitrary
// directories via this endpoint.
router.post("/save-path", requireRole("admin"), async (req, res) => {
  try {
    const { path: rawPath } = req.body || {};
    if (!rawPath || typeof rawPath !== "string") {
      return res.status(400).json({ error: "Missing path." });
    }
    let validated;
    try {
      validated = resolveCustomOrDefaultDataPath(rawPath);
    } catch (e) {
      // Surface validation details so the UI can render the same empty-state
      // remediation it gets from /saves.
      const payload = { error: sanitizeError(e.message) };
      if (e.details) payload.rejection = e.details;
      return res.status(e.statusCode || 400).json(payload);
    }
    if (!validated) {
      return res
        .status(400)
        .json({ error: "Path is empty after normalization." });
    }

    const activeServer = await getActiveServer();
    if (activeServer?.id) {
      await updateServer(activeServer.id, { zomboidDataPath: validated });
      log.info(
        `[ChunkCleaner] Saved zomboidDataPath to active server "${activeServer.name}": ${validated}`,
      );
      return res.json({
        ok: true,
        target: "server",
        serverId: activeServer.id,
        path: validated,
      });
    }
    await setSetting("zomboidDataPath", validated);
    log.info(
      `[ChunkCleaner] Saved zomboidDataPath to legacy settings: ${validated}`,
    );
    res.json({ ok: true, target: "setting", path: validated });
  } catch (error) {
    log.error(`Failed to save zomboid data path: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get chunk data for a specific save
router.get("/chunks/:saveName", async (req, res) => {
  try {
    const { saveName } = req.params;
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    // Optional progress streaming: the client passes a scanId and subscribes to
    // `chunkScan:progress` over Socket.IO. Scanning a huge save over a slow UNC
    // share can take a while, so we report % completion (by directory) instead
    // of capping the result. No scanId → no emits (back-compat).
    const scanId = req.query.scanId ? String(req.query.scanId) : null;
    const io = req.app.get("io");
    let lastProgressAt = 0;
    const emitProgress = (scanned, total, found, { force = false } = {}) => {
      if (!io || !scanId) return;
      const now = Date.now();
      // Throttle to ~5/sec to avoid flooding the socket on fast local disks.
      if (!force && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      io.emit("chunkScan:progress", { scanId, scanned, total, chunks: found });
    };

    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: "Invalid save name" });
    }

    let zomboidDataPath;
    if (customPath) {
      zomboidDataPath = resolveCustomOrDefaultDataPath(String(customPath));
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Zomboid data path not set" });
    }

    // Resolve the saves path the same way as /saves
    let savesPath = resolveSavesPath(zomboidDataPath);

    const savePath = path.join(savesPath, sanitizedSaveName);
    const mapPath = path.join(savePath, "map");

    log.info(
      `[ChunkCleaner] Loading chunks for "${sanitizedSaveName}" from: ${mapPath}`,
    );

    if (!fs.existsSync(savePath)) {
      log.warn(`[ChunkCleaner] Save directory not found: ${savePath}`);
      return res.json({ chunks: [], bounds: null });
    }

    const chunks = [];
    const seenChunkCoords = new Set();
    let minX = Infinity,
      maxX = -Infinity;
    let minY = Infinity,
      maxY = -Infinity;
    let totalChunks = 0;

    const mapExists = fs.existsSync(mapPath);

    // B42 uses subdirectory structure: map/{X}/{Y}.bin
    // B41 may use flat files inside map/ OR flat files in the save root
    let mapContents = [];
    let xDirs = [];
    let flatBinFiles = [];

    if (mapExists) {
      mapContents = await fs.promises.readdir(mapPath, { withFileTypes: true });
      xDirs = mapContents.filter(
        (d) => d.isDirectory() && /^\d+$/.test(d.name),
      );
      flatBinFiles = mapContents.filter(
        (f) => f.isFile() && f.name.endsWith(".bin"),
      );
    }

    log.info(
      `[ChunkCleaner] map/ ${mapExists ? "exists" : "missing"}: ${mapContents.length} entries, ${xDirs.length} numeric dirs (B42), ${flatBinFiles.length} flat .bin files (B41)`,
    );

    const rememberChunkCoord = (x, y) => {
      const key = `${x},${y}`;
      if (seenChunkCoords.has(key)) return false;
      seenChunkCoords.add(key);
      totalChunks++;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      return true;
    };

    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      // Use sequential directory scans to avoid overwhelming the filesystem.
      let totalBinFiles = 0;
      let totalNonBinFiles = 0;
      let sampleNonBinFiles = [];
      let emptyDirs = 0;
      let scannedDirs = 0;
      emitProgress(0, xDirs.length, 0, { force: true });

      for (const xDir of xDirs) {
        const x = parseInt(xDir.name, 10);
        const xPath = path.join(mapPath, xDir.name);

        try {
          // Read Y files in this X directory
          const yEntries = await fs.promises.readdir(xPath, {
            withFileTypes: true,
          });
          // Only process files (skip subdirectories inside chunk dirs)
          const yFiles = yEntries.filter((e) => e.isFile()).map((e) => e.name);

          if (yFiles.length === 0) {
            emptyDirs++;
            continue;
          }

          const binFiles = yFiles.filter((f) => f.endsWith(".bin"));
          const nonBinFiles = yFiles.filter((f) => !f.endsWith(".bin"));
          totalBinFiles += binFiles.length;
          totalNonBinFiles += nonBinFiles.length;
          if (nonBinFiles.length > 0 && sampleNonBinFiles.length < 5) {
            sampleNonBinFiles.push(
              ...nonBinFiles.slice(0, 3).map((f) => `${xDir.name}/${f}`),
            );
          }

          const chunkEntries = [];
          for (const yFile of binFiles) {
            const yMatch = yFile.match(/^(\d+)\.bin$/);
            if (!yMatch) continue;

            const y = parseInt(yMatch[1], 10);
            if (!rememberChunkCoord(x, y)) continue;

            chunkEntries.push({ x, y, yFile });
          }

          const results = await Promise.all(
            chunkEntries.map(async ({ x, y, yFile }) => {
              const filePath = path.join(xPath, yFile);

              try {
                const stats = await fs.promises.stat(filePath);
                return {
                  file: `${x}/${yFile}`,
                  x,
                  y,
                  size: stats.size,
                  modified: stats.mtime,
                };
              } catch (e) {
                log.debug(`Stat failed for chunk ${x}/${yFile}: ${e.message}`);
                return null;
              }
            }),
          );

          for (const chunk of results) {
            if (chunk) chunks.push(chunk);
          }
        } catch (err) {
          log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
        }

        scannedDirs++;
        emitProgress(scannedDirs, xDirs.length, chunks.length);
      }

      // Diagnostic: log what was found inside the B42 dirs
      log.info(
        `[ChunkCleaner] B42 scan: ${totalChunks} chunks loaded, ${totalBinFiles} .bin files, ${emptyDirs} empty dirs, ${totalNonBinFiles} non-.bin files${sampleNonBinFiles.length > 0 ? " (samples: " + sampleNonBinFiles.join(", ") + ")" : ""}`,
      );
      emitProgress(xDirs.length, xDirs.length, chunks.length, { force: true });
    } else {
      // Legacy flat file structure: map_X_Y.bin or X_Y.bin
      const files = mapContents
        .filter((f) => f.isFile() && f.name.endsWith(".bin"))
        .map((f) => f.name);

      const chunkEntries = [];
      for (const file of files) {
        // Common formats: map_X_Y.bin, chunkdata_X_Y.bin, X_Y.bin
        const match = file.match(
          /(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i,
        );
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          if (!rememberChunkCoord(x, y)) continue;

          chunkEntries.push({ file, x, y });
        }
      }

      const legacyResults = await Promise.all(
        chunkEntries.map(async ({ file, x, y }) => {
          try {
            const stats = await fs.promises.stat(path.join(mapPath, file));
            return {
              file,
              x,
              y,
              size: stats.size,
              modified: stats.mtime,
            };
          } catch (e) {
            log.debug(`Stat failed for legacy chunk ${file}: ${e.message}`);
            return null;
          }
        }),
      );

      for (const res of legacyResults) {
        if (res) {
          chunks.push(res);
        }
      }
    }

    // B41 fallback: if map/ didn't yield any chunks, check save root for
    // flat chunk files like map_X_Y.bin (common B41 save layout).
    let isB42 = xDirs.length > 0;

    // Secondary B42 detection: if map/ is empty (no subdirs, no flat files),
    // check for B42-specific files in the save root. B42 saves have files like
    // WorldDictionary.bin, global_mod_data.bin, entity_data.bin that B41 doesn't.
    if (!isB42 && chunks.length === 0) {
      const b42Indicators = [
        "WorldDictionary.bin",
        "global_mod_data.bin",
        "entity_data.bin",
      ];
      const hasB42Files = b42Indicators.some((f) =>
        fs.existsSync(path.join(savePath, f)),
      );
      if (hasB42Files) {
        isB42 = true;
        log.info(
          `[ChunkCleaner] Detected B42 save via indicator files (map/ is empty)`,
        );
      }
    }

    if (!isB42 && totalChunks === 0) {
      const B41_CHUNK_REGEX = /^map_(\d+)_(\d+)\.bin$/i;
      const rootEntries = await fs.promises.readdir(savePath, {
        withFileTypes: true,
      });
      const rootBinFiles = rootEntries.filter(
        (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
      );

      if (rootBinFiles.length > 0) {
        log.info(
          `[ChunkCleaner] Found ${rootBinFiles.length} B41 chunk files in save root`,
        );

        const chunkEntries = [];
        for (const entry of rootBinFiles) {
          const match = entry.name.match(B41_CHUNK_REGEX);
          if (!match) continue;

          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);
          if (!rememberChunkCoord(x, y)) continue;

          chunkEntries.push({ entry, x, y });
        }

        const rootResults = await Promise.all(
          chunkEntries.map(async ({ entry, x, y }) => {
            try {
              const stats = await fs.promises.stat(
                path.join(savePath, entry.name),
              );
              return {
                file: entry.name,
                x,
                y,
                size: stats.size,
                modified: stats.mtime,
                source: "saveroot",
              };
            } catch (e) {
              log.debug(
                `Stat failed for B41 root chunk ${entry.name}: ${e.message}`,
              );
              return null;
            }
          }),
        );

        for (const res of rootResults) {
          if (res) {
            chunks.push(res);
          }
        }
      }
    }

    // Also check chunkdata folder for additional chunk data.
    // In B41 saves, chunkdata coords match chunk coords directly.
    // In B42 saves, chunkdata uses CELL coordinates and is converted here to
    // native B42 chunk coordinates (× 32). Original cell coords are preserved
    // in cellX/cellY for deletion operations.
    //
    // NOTE: chunkdata entries are kept in a SEPARATE dedup namespace from map
    // chunks. A chunkdata entry represents an entire cell's state (256×256
    // tiles on B42), not just the corner chunk. Previously these got dropped
    // when `map/0/0.bin` already claimed coord (0,0) — which meant the user
    // could not select the cell-wide chunkdata entry, and its cell-span
    // vehicle/state cleanup never ran.
    const seenChunkDataCoords = new Set();
    {
      const chunkDataPath = path.join(savePath, "chunkdata");
      if (fs.existsSync(chunkDataPath)) {
        const chunkDataFiles = await fs.promises.readdir(chunkDataPath);
        const validFiles = chunkDataFiles.filter((f) => f.endsWith(".bin"));

        const chunkEntries = [];
        for (const file of validFiles) {
          const match = file.match(/(\d+)_(\d+)(?:_\d+)?\.bin$/i);
          if (match) {
            const rawX = parseInt(match[1], 10);
            const rawY = parseInt(match[2], 10);

            const displayX = isB42 ? rawX * 32 : rawX * 30;
            const displayY = isB42 ? rawY * 32 : rawY * 30;

            // Dedup against ONLY other chunkdata entries, not against map
            // chunks — the two sources cover different amounts of world state.
            const cdKey = `${displayX},${displayY}`;
            if (seenChunkDataCoords.has(cdKey)) continue;
            seenChunkDataCoords.add(cdKey);
            // Track for bounds even though rememberChunkCoord was skipped.
            minX = Math.min(minX, displayX);
            maxX = Math.max(maxX, displayX);
            minY = Math.min(minY, displayY);
            maxY = Math.max(maxY, displayY);
            totalChunks++;

            chunkEntries.push({ file, rawX, rawY, displayX, displayY });
          }
        }

        const chunkDataResults = await Promise.all(
          chunkEntries.map(async ({ file, rawX, rawY, displayX, displayY }) => {
            try {
              const stats = await fs.promises.stat(
                path.join(chunkDataPath, file),
              );
              return {
                file,
                x: displayX,
                y: displayY,
                size: stats.size,
                modified: stats.mtime,
                source: "chunkdata",
                cellX: rawX,
                cellY: rawY,
              };
            } catch (e) {
              log.debug(`Stat failed for chunkdata ${file}: ${e.message}`);
              return null;
            }
          }),
        );

        for (const res of chunkDataResults) {
          if (res) {
            chunks.push(res);
          }
        }
      }
    }

    const bounds = chunks.length > 0 ? { minX, maxX, minY, maxY } : null;

    // Sort chunks by coordinate for consistent rendering order
    chunks.sort((a, b) => a.x - b.x || a.y - b.y);

    res.json({
      saveName,
      chunks,
      shownChunks: chunks.length,
      totalChunks,
      bounds,
      limitReached: false,
      maxChunks: null,
      isB42,
    });
  } catch (error) {
    // resolveCustomOrDefaultDataPath throws 400/403 for bad custom paths —
    // forward that status (and structured rejection details) instead of
    // masking it as a generic 500 so the UI can render targeted remediation.
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError)
      log.warn(`Get chunks rejected (${error.statusCode}): ${error.message}`);
    else log.error(`Failed to get chunks: ${error.message}`);
    const payload = { error: sanitizeError(error.message) };
    if (error.details) payload.rejection = error.details;
    res.status(error.statusCode || 500).json(payload);
  }
});

// Delete selected chunks
router.post("/delete-chunks", requireRole("admin"), async (req, res) => {
  try {
    const {
      saveName,
      chunks,
      createBackup = true,
      customPath = null,
      deleteVehicles = false,
      force = false,
    } = req.body;
    log.info(
      `POST /delete-chunks: saveName=${saveName}, chunkCount=${chunks?.length || 0}, createBackup=${createBackup}, deleteVehicles=${!!deleteVehicles}, force=${!!force}`,
    );

    // Refuse to mutate save files while the server is running — it will write
    // them back on shutdown and corrupt the save, or hold vehicles.db open
    // on Windows and cause the DB write to fail mid-flight.
    //
    // Issue #5: detection can false-positive when the user runs the server
    // via a custom systemd unit / launcher we don't recognise, or when an
    // unrelated java process matches our heuristics. We surface the matched
    // process info and accept `force: true` so users can override after
    // confirming the server really is stopped.
    if (!force) {
      try {
        const serverManager = req.app.get("serverManager");
        if (
          serverManager &&
          typeof serverManager.getServerProcessDetails === "function"
        ) {
          const details = await serverManager.getServerProcessDetails();
          if (details.running) {
            return res.status(400).json({
              error:
                "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
              code: "server_running",
              matched: details.matched,
            });
          }
        } else if (
          serverManager &&
          typeof serverManager.checkServerRunning === "function"
        ) {
          const isRunning = await serverManager.checkServerRunning();
          if (isRunning) {
            return res.status(400).json({
              error:
                "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
              code: "server_running",
            });
          }
        }
      } catch (e) {
        log.warn(
          `Server-running check failed (proceeding cautiously): ${e.message}`,
        );
      }
    } else {
      log.warn("delete-chunks: server-running check bypassed via force=true");
    }

    if (!saveName || !chunks || !Array.isArray(chunks) || chunks.length === 0) {
      return res
        .status(400)
        .json({ error: "Save name and chunks array required" });
    }

    // Cap chunk count explicitly. Express body-parser already rejects >1MB
    // payloads with a cryptic PayloadTooLargeError; this check fires earlier
    // and gives a clear message. 100k matches the region endpoint's cap.
    if (chunks.length > 100000) {
      return res.status(400).json({
        error: `Too many chunks (${chunks.length.toLocaleString()}). Maximum is 100,000 per request — split into smaller batches.`,
      });
    }

    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: "Invalid save name" });
    }

    // Validate chunk files and coordinates
    for (const chunk of chunks) {
      if (!chunk.file) {
        return res.status(400).json({ error: "Invalid chunk file name" });
      }
      const normalized = path.normalize(chunk.file);
      if (normalized.includes("..") || path.isAbsolute(normalized)) {
        return res.status(400).json({ error: "Invalid chunk file path" });
      }
      if (chunk.x !== undefined && chunk.x !== null) {
        const nx = Number(chunk.x);
        if (!Number.isFinite(nx) || !Number.isInteger(nx)) {
          return res
            .status(400)
            .json({ error: "Invalid chunk x coordinate — must be an integer" });
        }
        chunk.x = nx;
      }
      if (chunk.y !== undefined && chunk.y !== null) {
        const ny = Number(chunk.y);
        if (!Number.isFinite(ny) || !Number.isInteger(ny)) {
          return res
            .status(400)
            .json({ error: "Invalid chunk y coordinate — must be an integer" });
        }
        chunk.y = ny;
      }
    }

    const zomboidDataPath = customPath
      ? resolveCustomOrDefaultDataPath(String(customPath))
      : await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Zomboid data path not set" });
    }

    const savesPath = resolveSavesPath(zomboidDataPath);
    const savePath = path.join(savesPath, sanitizedSaveName);

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({ error: "Save not found" });
    }

    // B42 vs B41 detection — filesystem-based, not filename-based.
    // Filename inference (chunks.some(c => c.file.includes('/'))) silently
    // mis-detects selections made of only `chunkdata_X_Y.bin` entries on B42
    // saves. That would compute the wrong cell size and the wrong vehicle
    // bbox (30×10 B41 tiles vs 32×8 B42 tiles).
    const isB42 = detectSaveIsB42Sync(savePath);
    const cellDivisor = cellDivisorFor(isB42);
    const tilesPerChunk = tilesPerChunkFor(isB42);

    // Backfill cell coordinates for chunkdata-origin and map-origin chunks.
    // Use == null (not === undefined) so a null from the client JSON payload
    // is also treated as "needs backfill" — otherwise touchedCells ends up
    // with "null,null" keys and per-cell aux cleanup silently skips.
    for (const chunk of chunks) {
      if (chunk.source === "chunkdata" && chunk.cellX == null) {
        const cdMatch = chunk.file.match(/(\d+)_(\d+)/);
        if (cdMatch) {
          chunk.cellX = parseInt(cdMatch[1], 10);
          chunk.cellY = parseInt(cdMatch[2], 10);
        }
      }
      if (chunk.cellX == null) chunk.cellX = Math.floor(chunk.x / cellDivisor);
      if (chunk.cellY == null) chunk.cellY = Math.floor(chunk.y / cellDivisor);
    }

    // Create backup if requested. We back up map files AND vehicles.db (if
    // vehicles are being deleted) so the operation is fully reversible.
    let backupPath = null;
    if (createBackup) {
      backupPath = path.join(
        zomboidDataPath,
        "backups",
        `${sanitizedSaveName}_chunks_${Date.now()}`,
      );
      await fs.promises.mkdir(backupPath, { recursive: true });

      await Promise.all(
        chunks.map(async (chunk) => {
          try {
            // Use source as a prefix so a B42 map chunk (`0/0.bin`) and a B41
            // save-root chunk (`0_0.bin`) can coexist in the same backup without
            // colliding to `map_0_0.bin` + EEXIST (which COPYFILE_EXCL would
            // otherwise silently drop as a warn).
            const srcTag =
              chunk.source === "saveroot"
                ? "saveroot"
                : chunk.source === "chunkdata"
                  ? "chunkdata"
                  : "map";
            const mapFile =
              chunk.source === "saveroot"
                ? path.join(savePath, chunk.file)
                : path.join(savePath, "map", chunk.file);
            try {
              const backupName = `${srcTag}_${chunk.file.replace(/[/\\]/g, "_")}`;
              await copyChunkBackup(
                mapFile,
                path.join(backupPath, backupName),
                true,
              );
            } catch (e) {
              if (e.code !== "ENOENT") throw e;
            }
            if (chunk.source === "chunkdata") {
              const chunkDataFile = path.join(
                savePath,
                "chunkdata",
                chunk.file,
              );
              try {
                const backupName = `chunkdata_${chunk.file.replace(/[/\\]/g, "_")}`;
                await copyChunkBackup(
                  chunkDataFile,
                  path.join(backupPath, backupName),
                  true,
                );
              } catch (e) {
                if (e.code !== "ENOENT") throw e;
              }
            }
          } catch (e) {
            log.error(`Failed to backup chunk ${chunk.file}: ${e.message}`);
            throw e;
          }
        }),
      );

      log.info(`Created chunk backup at ${backupPath}`);
    }

    // ─── Pass 1: delete the chunk files themselves ──────────────────────
    let deleted = 0;
    const errors = [];
    const touchedCells = new Set();

    const deleteResults = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          let wasDeleted = false;

          if (chunk.source === "chunkdata") {
            // Pure chunkdata entry (no map file) — delete the chunkdata file directly.
            // Use the ACTUAL filename captured by the scanner (it may be
            // `chunkdata_X_Y.bin` OR a bare `X_Y.bin` depending on save layout).
            const chunkDataFile = path.join(savePath, "chunkdata", chunk.file);
            try {
              await fs.promises.unlink(chunkDataFile);
              wasDeleted = true;
            } catch (e) {
              if (e.code !== "ENOENT")
                return {
                  success: false,
                  error: `chunkdata: ${e.message}`,
                  file: chunk.file,
                };
            }
          } else {
            const mapFile =
              chunk.source === "saveroot"
                ? path.join(savePath, chunk.file)
                : path.join(savePath, "map", chunk.file);
            try {
              await fs.promises.unlink(mapFile);
              wasDeleted = true;
            } catch (e) {
              if (e.code !== "ENOENT")
                return {
                  success: false,
                  error: sanitizeError(e.message),
                  file: chunk.file,
                };
            }
          }

          if (wasDeleted) {
            touchedCells.add(`${chunk.cellX},${chunk.cellY}`);
          }
          return { success: true, wasDeleted };
        } catch (err) {
          return {
            success: false,
            error: sanitizeError(err.message),
            file: chunk.file,
          };
        }
      }),
    );

    for (const r of deleteResults) {
      if (r.success) {
        if (r.wasDeleted) deleted++;
      } else errors.push(`${r.file}: ${r.error}`);
    }

    // ─── Pass 2: remove per-cell aux files only for cells that are now empty ───
    // (Fixes the overreach bug that made one chunk deletion wipe cell state
    // for 1023 innocent neighbours.)
    const cellCleanup = await cleanupEmptyCellFiles(
      savePath,
      touchedCells,
      isB42,
      backupPath,
    );

    // Clean up empty X directories (B42)
    const deletedXDirs = new Set();
    for (const chunk of chunks) {
      const parts = chunk.file.split("/");
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xPath = path.join(savePath, "map", xDir);
        const remaining = await fs.promises.readdir(xPath);
        if (remaining.length === 0) await fs.promises.rmdir(xPath);
      } catch (e) {
        /* ignore */
      }
    }

    // ─── Pass 3: delete matching rows from vehicles.db ─────────────────
    // This is the critical fix for "cars come back when I return to the cell".
    // Runtime PanelBridge only touches loaded vehicles; the DB retains every
    // other one. We delete every vehicle whose world tile coords fall inside
    // one of the just-deleted chunks.
    let vehiclesResult = { deleted: 0, skipped: true };
    if (deleteVehicles && deleted > 0) {
      const dbBackup = backupPath
        ? path.join(backupPath, "vehicles.db.bak")
        : null;
      // Build tile bboxes. chunkdata-source entries cover a whole cell
      // (not just one chunk) — expand them so we don't miss vehicles in the
      // other 1023 chunks of that cell.
      // Also supply wx/wy (chunk-coord) bounds so vehicles with drifted tile
      // coords but valid chunk coords still get matched.
      const cellTileSpan = cellDivisor * tilesPerChunk;
      const boxes = chunks
        .filter((c) => c.cellX != null && c.cellY != null)
        .map((c) => {
          if (c.source === "chunkdata") {
            const x0 = c.cellX * cellTileSpan;
            const y0 = c.cellY * cellTileSpan;
            // chunkdata covers the whole cell, so wx spans cellDivisor chunks.
            const wx0 = c.cellX * cellDivisor;
            const wy0 = c.cellY * cellDivisor;
            return {
              x0,
              x1: x0 + cellTileSpan,
              y0,
              y1: y0 + cellTileSpan,
              wx0,
              wx1: wx0 + cellDivisor,
              wy0,
              wy1: wy0 + cellDivisor,
            };
          }
          const x0 = c.x * tilesPerChunk;
          const y0 = c.y * tilesPerChunk;
          return {
            x0,
            x1: x0 + tilesPerChunk,
            y0,
            y1: y0 + tilesPerChunk,
            wx0: c.x,
            wx1: c.x + 1,
            wy0: c.y,
            wy1: c.y + 1,
          };
        });
      try {
        vehiclesResult = await deleteVehiclesInBoxes(savePath, boxes, {
          backupPath: dbBackup,
        });
        log.info(`vehicles.db: removed ${vehiclesResult.deleted} rows`);
      } catch (e) {
        log.warn(`vehicles.db cleanup failed: ${e.message}`);
        errors.push(`vehicles.db: ${e.message}`);
      }
    }

    log.info(
      `Deleted ${deleted} chunks from save ${sanitizedSaveName} (cell aux files removed: ${cellCleanup.removed.length}, vehicles removed: ${vehiclesResult.deleted})`,
    );

    res.json({
      success: true,
      deleted,
      vehiclesDeleted: vehiclesResult.deleted || 0,
      cellFilesRemoved: cellCleanup.removed.length,
      errors: errors.length > 0 ? errors : undefined,
      backupCreated: createBackup,
    });
  } catch (error) {
    log.error(`Failed to delete chunks: ${error.message}`);
    res
      .status(error.statusCode || 500)
      .json({ error: sanitizeError(error.message) });
  }
});

// Delete chunks by region (x/y coordinate range)
router.post("/delete-region", requireRole("admin"), async (req, res) => {
  try {
    const {
      saveName,
      minX,
      maxX,
      minY,
      maxY,
      createBackup = true,
      invert = false,
      customPath = null,
      deleteVehicles = false,
      force = false,
    } = req.body;

    // Refuse to mutate save files while the server is running. See the
    // delete-chunks handler above for the full rationale and `force` escape
    // hatch (issue #5: detection can false-positive on custom launchers).
    if (!force) {
      try {
        const serverManager = req.app.get("serverManager");
        if (
          serverManager &&
          typeof serverManager.getServerProcessDetails === "function"
        ) {
          const details = await serverManager.getServerProcessDetails();
          if (details.running) {
            return res.status(400).json({
              error:
                "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
              code: "server_running",
              matched: details.matched,
            });
          }
        } else if (
          serverManager &&
          typeof serverManager.checkServerRunning === "function"
        ) {
          const isRunning = await serverManager.checkServerRunning();
          if (isRunning) {
            return res.status(400).json({
              error:
                "Stop the server before deleting chunks. Running servers hold save files open and will overwrite your changes on shutdown.",
              code: "server_running",
            });
          }
        }
      } catch (e) {
        log.warn(
          `Server-running check failed (proceeding cautiously): ${e.message}`,
        );
      }
    } else {
      log.warn("delete-region: server-running check bypassed via force=true");
    }

    if (
      !saveName ||
      minX === undefined ||
      maxX === undefined ||
      minY === undefined ||
      maxY === undefined
    ) {
      return res
        .status(400)
        .json({ error: "Save name and region bounds required" });
    }

    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: "Invalid save name" });
    }

    // Validate bounds are numbers
    if (
      typeof minX !== "number" ||
      typeof maxX !== "number" ||
      typeof minY !== "number" ||
      typeof maxY !== "number" ||
      !Number.isFinite(minX) ||
      !Number.isFinite(maxX) ||
      !Number.isFinite(minY) ||
      !Number.isFinite(maxY)
    ) {
      return res
        .status(400)
        .json({ error: "Region bounds must be finite numbers" });
    }
    // Reject swapped bounds — otherwise a non-invert selection silently
    // matches nothing and the caller sees an unhelpful "0 deleted".
    if (minX > maxX || minY > maxY) {
      return res
        .status(400)
        .json({ error: "Region bounds inverted (minX > maxX or minY > maxY)" });
    }

    const zomboidDataPath = customPath
      ? resolveCustomOrDefaultDataPath(String(customPath))
      : await getZomboidDataPath();
    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Zomboid data path not set" });
    }

    const savesPath = resolveSavesPath(zomboidDataPath);
    const savePath = path.join(savesPath, sanitizedSaveName);
    const mapPath = path.join(savePath, "map");

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({ error: "Save not found" });
    }

    const mapExists = fs.existsSync(mapPath);

    // Get all chunks - handle B42 directory structure, B41 flat files in map/, and B41 flat files in save root
    const chunksToDelete = [];
    let mapContents = [];
    let xDirs = [];

    if (mapExists) {
      mapContents = await fs.promises.readdir(mapPath, { withFileTypes: true });
      xDirs = mapContents.filter(
        (d) => d.isDirectory() && /^\d+$/.test(d.name),
      );
    }

    if (xDirs.length > 0) {
      // B42 structure: map/{X}/{Y}.bin
      await Promise.all(
        xDirs.map(async (xDir) => {
          const x = parseInt(xDir.name, 10);
          // Quick AABB check: if entire X row is out of X bounds, skip it
          if (!invert && (x < minX || x > maxX)) return;

          const xPath = path.join(mapPath, xDir.name);

          try {
            const yFiles = await fs.promises.readdir(xPath);
            const binFiles = yFiles.filter((f) => f.endsWith(".bin"));

            for (const yFile of binFiles) {
              const yMatch = yFile.match(/^(\d+)\.bin$/);
              if (yMatch) {
                const y = parseInt(yMatch[1], 10);

                const inRegion =
                  x >= minX && x <= maxX && y >= minY && y <= maxY;
                const shouldDelete = invert ? !inRegion : inRegion;

                if (shouldDelete) {
                  chunksToDelete.push({ file: `${x}/${yFile}`, x, y });
                }
              }
            }
          } catch (err) {
            log.warn(`Error reading chunk directory ${xPath}: ${err.message}`);
          }
        }),
      );
    } else {
      // Legacy flat file structure in map/ directory
      const files = mapContents
        .filter((f) => f.isFile() && f.name.endsWith(".bin"))
        .map((f) => f.name);

      for (const file of files) {
        const match = file.match(
          /(?:map_|chunkdata_|chunk_)?(\d+)_(\d+)(?:_\d+)?\.bin$/i,
        );
        if (match) {
          const x = parseInt(match[1], 10);
          const y = parseInt(match[2], 10);

          const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
          const shouldDelete = invert ? !inRegion : inRegion;

          if (shouldDelete) {
            chunksToDelete.push({ file, x, y });
          }
        }
      }

      // B41 save-root fallback: check for map_X_Y.bin in save root
      if (chunksToDelete.length === 0) {
        const B41_CHUNK_REGEX = /^map_(\d+)_(\d+)\.bin$/i;
        const rootEntries = await fs.promises.readdir(savePath, {
          withFileTypes: true,
        });
        const rootBinFiles = rootEntries.filter(
          (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
        );

        for (const entry of rootBinFiles) {
          const match = entry.name.match(B41_CHUNK_REGEX);
          if (match) {
            const x = parseInt(match[1], 10);
            const y = parseInt(match[2], 10);

            const inRegion = x >= minX && x <= maxX && y >= minY && y <= maxY;
            const shouldDelete = invert ? !inRegion : inRegion;

            if (shouldDelete) {
              chunksToDelete.push({
                file: entry.name,
                x,
                y,
                source: "saveroot",
              });
            }
          }
        }
      }
    }

    if (chunksToDelete.length === 0) {
      return res.json({
        success: true,
        deleted: 0,
        message: "No chunks in selected region",
      });
    }

    // Safety limit to prevent accidental mass deletion
    if (chunksToDelete.length > 100000) {
      return res.status(400).json({
        error: `Region too large (${chunksToDelete.length.toLocaleString()} chunks). Maximum is 100,000 at a time.`,
      });
    }

    // Create backup if requested
    let backupPath = null;
    if (createBackup) {
      backupPath = path.join(
        zomboidDataPath,
        "backups",
        `${sanitizedSaveName}_region_${Date.now()}`,
      );
      await fs.promises.mkdir(backupPath, { recursive: true });

      // Parallel backup
      await Promise.all(
        chunksToDelete.map(async (chunk) => {
          const srcFile =
            chunk.source === "saveroot"
              ? path.join(savePath, chunk.file)
              : path.join(mapPath, chunk.file);
          try {
            const backupName = `map_${chunk.file.replace(/[/\\]/g, "_")}`;
            await copyChunkBackup(
              srcFile,
              path.join(backupPath, backupName),
            );
          } catch (e) {
            if (e.code !== "ENOENT") throw e;
          }
        }),
      );

      // Save region info
      await fs.promises.writeFile(
        path.join(backupPath, "region_info.json"),
        JSON.stringify(
          {
            minX,
            maxX,
            minY,
            maxY,
            invert,
            chunksDeleted: chunksToDelete.length,
          },
          null,
          2,
        ),
      );

      log.info(`Created region backup at ${backupPath}`);
    }

    // Delete chunks
    let deleted = 0;
    const touchedCells = new Set();
    const regionIsB42 = xDirs.length > 0;
    const regionCellDiv = cellDivisorFor(regionIsB42);

    await Promise.all(
      chunksToDelete.map(async (chunk) => {
        try {
          const chunkFile =
            chunk.source === "saveroot"
              ? path.join(savePath, chunk.file)
              : path.join(mapPath, chunk.file);
          await fs.promises.unlink(chunkFile);
          deleted++;
          touchedCells.add(
            `${Math.floor(chunk.x / regionCellDiv)},${Math.floor(chunk.y / regionCellDiv)}`,
          );
        } catch (err) {
          if (err.code !== "ENOENT")
            log.warn(`Failed to delete chunk ${chunk.file}: ${err.message}`);
        }
      }),
    );

    // Per-cell aux cleanup — only for cells that are now fully empty on disk.
    const cellCleanup = await cleanupEmptyCellFiles(
      savePath,
      touchedCells,
      regionIsB42,
      backupPath,
    );

    // Clean up empty X directories after B42 chunk deletion
    const deletedXDirs = new Set();
    for (const chunk of chunksToDelete) {
      const parts = chunk.file.split("/");
      if (parts.length === 2) deletedXDirs.add(parts[0]);
    }
    for (const xDir of deletedXDirs) {
      try {
        const xDirPath = path.join(mapPath, xDir);
        const remaining = await fs.promises.readdir(xDirPath);
        if (remaining.length === 0) await fs.promises.rmdir(xDirPath);
      } catch (e) {
        if (e.code !== "ENOENT")
          log.debug(`Failed to clean up empty dir ${xDir}: ${e.message}`);
      }
    }

    // Vehicles.db cleanup (optional, destructive).
    // Backup lives inside the chunk backup folder (if one was made) so a
    // single restore operation covers everything from this call. Matches the
    // layout used by /delete-chunks.
    let vehiclesResult = { deleted: 0, skipped: true };
    if (deleteVehicles && deleted > 0) {
      const tilesPerChunk = tilesPerChunkFor(regionIsB42);
      const dbBackup =
        createBackup && typeof backupPath === "string"
          ? path.join(backupPath, "vehicles.db.bak")
          : null;
      const boxes = chunksToDelete.map((c) => {
        const x0 = c.x * tilesPerChunk;
        const y0 = c.y * tilesPerChunk;
        return {
          x0,
          x1: x0 + tilesPerChunk,
          y0,
          y1: y0 + tilesPerChunk,
          wx0: c.x,
          wx1: c.x + 1,
          wy0: c.y,
          wy1: c.y + 1,
        };
      });
      try {
        vehiclesResult = await deleteVehiclesInBoxes(savePath, boxes, {
          backupPath: dbBackup,
        });
        log.info(
          `vehicles.db: removed ${vehiclesResult.deleted} rows from region`,
        );
      } catch (e) {
        log.warn(`vehicles.db region cleanup failed: ${e.message}`);
      }
    }

    log.info(
      `Deleted ${deleted} chunks in region [${minX},${minY}]-[${maxX},${maxY}] from ${sanitizedSaveName} (cell files removed: ${cellCleanup.removed.length}, vehicles: ${vehiclesResult.deleted})`,
    );

    res.json({
      success: true,
      deleted,
      vehiclesDeleted: vehiclesResult.deleted || 0,
      cellFilesRemoved: cellCleanup.removed.length,
      region: { minX, maxX, minY, maxY },
      inverted: invert,
    });
  } catch (error) {
    log.error(`Failed to delete region: ${error.message}`);
    res
      .status(error.statusCode || 500)
      .json({ error: sanitizeError(error.message) });
  }
});

// Get save statistics
router.get("/stats/:saveName", async (req, res) => {
  try {
    const { saveName } = req.params;
    const customPath = req.query.customPath
      ? String(req.query.customPath)
      : null;

    // Sanitize saveName to prevent path traversal
    const sanitizedSaveName = path.basename(saveName);
    if (!sanitizedSaveName || sanitizedSaveName !== saveName) {
      return res.status(400).json({ error: "Invalid save name" });
    }

    let zomboidDataPath;
    if (customPath) {
      // Validate custom path the same way /saves and /chunks do — prevents
      // arbitrary filesystem reads via the stats endpoint.
      zomboidDataPath = resolveCustomOrDefaultDataPath(String(customPath));
    } else {
      zomboidDataPath = await getZomboidDataPath();
    }

    if (!zomboidDataPath) {
      return res.status(400).json({ error: "Zomboid data path not set" });
    }

    // Resolve the saves path the same way as /saves
    let savesPath = resolveSavesPath(zomboidDataPath);

    const savePath = path.join(savesPath, sanitizedSaveName);

    if (!fs.existsSync(savePath)) {
      return res.status(404).json({ error: "Save not found" });
    }

    const stats = {
      saveName,
      totalSize: await getDirSize(savePath), // Now awaited
      folders: {},
    };

    const folders = [
      "map",
      "chunkdata",
      "isoregiondata",
      "zpop",
      "metagrid",
      "apop",
      "radio",
    ];

    for (const folder of folders) {
      const folderPath = path.join(savePath, folder);
      try {
        if (fs.existsSync(folderPath)) {
          const fileCount = await countFiles(folderPath);
          const size = await getDirSize(folderPath);
          stats.folders[folder] = {
            fileCount,
            size,
            sizeFormatted: formatBytes(size),
          };
        }
      } catch (e) {
        log.debug(`Failed to stat folder ${folder}: ${e.message}`);
      }
    }

    // B41 root chunk files: count map_X_Y.bin in save root when map/ has no chunks
    if (!stats.folders.map || stats.folders.map.fileCount === 0) {
      const B41_CHUNK_REGEX = /^map_\d+_\d+\.bin$/i;
      try {
        const rootEntries = await fs.promises.readdir(savePath, {
          withFileTypes: true,
        });
        const rootChunks = rootEntries.filter(
          (f) => f.isFile() && B41_CHUNK_REGEX.test(f.name),
        );
        if (rootChunks.length > 0) {
          let rootChunkSize = 0;
          for (const f of rootChunks) {
            try {
              const s = await fs.promises.stat(path.join(savePath, f.name));
              rootChunkSize += s.size;
            } catch (e) {
              log.debug(`Stat failed for root chunk ${f.name}: ${e.message}`);
            }
          }
          stats.folders["map (root)"] = {
            fileCount: rootChunks.length,
            size: rootChunkSize,
            sizeFormatted: formatBytes(rootChunkSize),
          };
        }
      } catch (e) {
        log.debug(`B41 root chunk scan failed: ${e.message}`);
      }
    }

    // Players count
    const playersDb = path.join(savePath, "players.db");
    if (fs.existsSync(playersDb)) {
      try {
        const s = await fs.promises.stat(playersDb);
        stats.playersDbSize = s.size;
      } catch (e) {
        log.debug(`Stat failed for players.db: ${e.message}`);
      }
    }

    // Vehicles db
    const vehiclesDb = path.join(savePath, "vehicles.db");
    if (fs.existsSync(vehiclesDb)) {
      try {
        const s = await fs.promises.stat(vehiclesDb);
        stats.vehiclesDbSize = s.size;
      } catch (e) {
        log.debug(`Stat failed for vehicles.db: ${e.message}`);
      }
    }

    stats.totalSizeFormatted = formatBytes(stats.totalSize);

    res.json(stats);
  } catch (error) {
    const isUserError = error.statusCode && error.statusCode < 500;
    if (isUserError)
      log.warn(`Get stats rejected (${error.statusCode}): ${error.message}`);
    else log.error(`Failed to get save stats: ${error.message}`);
    const payload = { error: sanitizeError(error.message) };
    if (error.details) payload.rejection = error.details;
    res.status(error.statusCode || 500).json(payload);
  }
});

// Helper functions
async function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const files = await fs.promises.readdir(dirPath, { withFileTypes: true });

    const promises = files.map(async (file) => {
      const filePath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        return getDirSize(filePath);
      } else {
        try {
          const stats = await fs.promises.stat(filePath);
          return stats.size;
        } catch (e) {
          return 0;
        }
      }
    });
    const sizes = await Promise.all(promises);
    totalSize = sizes.reduce((a, b) => a + b, 0);
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "ENOENT")
      log.debug(`getDirSize error for ${dirPath}: ${err.message}`);
  }
  return totalSize;
}

// Count files recursively (handles B42's subdirectory structure)
// Uses parallel I/O for speed on large saves with many chunk directories.
async function countFiles(dirPath) {
  let count = 0;
  try {
    const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
    const subdirPromises = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        subdirPromises.push(countFiles(path.join(dirPath, entry.name)));
      } else {
        count++;
      }
    }
    if (subdirPromises.length > 0) {
      const subCounts = await Promise.all(subdirPromises);
      count += subCounts.reduce((a, b) => a + b, 0);
    }
  } catch (err) {
    if (err.code !== "EACCES" && err.code !== "ENOENT")
      log.debug(`countFiles error for ${dirPath}: ${err.message}`);
  }
  return count;
}

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// Browse a path — list directories for manual navigation. Confined to the
// active server's zomboidDataPath so this can't be used to walk the entire
// host filesystem (it was previously unconfined path.resolve()).
router.get("/browse", async (req, res) => {
  try {
    const browsePath = req.query.path ? String(req.query.path) : null;
    const zomboidDataPath = await getZomboidDataPath();

    if (!browsePath) {
      // Return the current zomboidDataPath as starting point
      return res.json({
        currentPath: zomboidDataPath || "",
        directories: [],
        hasSaves: false,
      });
    }

    if (!zomboidDataPath) {
      return res
        .status(400)
        .json({ error: "No Zomboid data path configured to browse" });
    }

    const allowedRoots = [path.resolve(zomboidDataPath)];
    const resolved = confineToRoots(browsePath, allowedRoots);
    if (!resolved) {
      return res.status(403).json({
        error: "Access denied: path is outside the server's save directory",
      });
    }

    if (!fs.existsSync(resolved)) {
      return res.status(400).json({ error: "Path does not exist" });
    }

    const stat = await fs.promises.stat(resolved);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }

    const entries = await fs.promises.readdir(resolved, {
      withFileTypes: true,
    });
    const directories = entries
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();

    // Check if this path has a Saves/Multiplayer structure
    const savesMultiplayer = path.join(resolved, "Saves", "Multiplayer");
    const hasSavesMultiplayer = fs.existsSync(savesMultiplayer);

    // Or if it IS a Saves/Multiplayer path
    const basename = path.basename(resolved);
    const parentBase = path.basename(path.dirname(resolved));
    const isSavesMultiplayer =
      basename === "Multiplayer" && parentBase === "Saves";

    // Check if any child dirs contain a map/ folder or B41 root chunk files (direct save dirs)
    const B41_ROOT_REGEX = /^map_\d+_\d+\.bin$/i;
    const hasMapFolders = directories.some((d) => {
      const childPath = path.join(resolved, d);
      if (fs.existsSync(path.join(childPath, "map"))) return true;
      // B41 fallback: check for map_X_Y.bin files in the child directory
      try {
        const childFiles = fs.readdirSync(childPath);
        return childFiles.some((f) => B41_ROOT_REGEX.test(f));
      } catch (e) {
        log.debug(`B41 check failed for ${d}: ${e.message}`);
        return false;
      }
    });

    res.json({
      currentPath: resolved,
      directories,
      hasSaves: hasSavesMultiplayer || isSavesMultiplayer || hasMapFolders,
      parent:
        path.dirname(resolved) !== resolved &&
        confineToRoots(path.dirname(resolved), allowedRoots)
          ? path.dirname(resolved)
          : null,
    });
  } catch (error) {
    log.error(`Failed to browse path: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
