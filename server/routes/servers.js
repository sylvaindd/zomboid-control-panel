import express from "express";
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
const log = createLogger("API:Servers");
import {
  sanitizeError,
  sanitizeServerResponse,
  sanitizeServerResponseList,
  isMaskedSecret,
} from "../utils/sanitize.js";
import { normalizeRconHost, testRconConnection } from "../services/rcon.js";
import {
  getServers,
  getServer,
  getActiveServer,
  createServer,
  updateServer,
  deleteServer,
  setActiveServer,
  getAllSettings,
} from "../database/init.js";
import { isRemoteConfigConfigured } from "../services/remoteConfigFiles.js";
import { requireRole } from "../services/auth.js";
import {
  canAutoInstall,
  checkBridgeInstalled,
  installBridge,
} from "../services/panelBridgeInstaller.js";

const router = express.Router();

// serverName is interpolated into filesystem paths (server-files, backups,
// chunks) as `${serverName}.ini` etc. — reject anything but a plain,
// non-traversal-capable name up front instead of relying on every
// downstream path-building call site to re-validate it.
const SERVER_NAME_REGEX =
  /^[a-zA-Z0-9_-][a-zA-Z0-9_\- ]*[a-zA-Z0-9_-]$|^[a-zA-Z0-9_-]$/;

function isValidServerName(value) {
  return typeof value === "string" && SERVER_NAME_REGEX.test(value);
}

function isValidDockerContainerRef(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Auto-install/update PanelBridge.lua on the newly-activated server when the
// panel has direct filesystem access to its install directory. Best-effort:
// logs and swallows any failure rather than affecting activation.
function autoInstallBridgeIfNeeded(server) {
  try {
    if (!canAutoInstall(server)) return;
    const status = checkBridgeInstalled(server);
    if (status.installed && !status.needsUpdate) return;

    const result = installBridge(server);
    if (result.success) {
      log.info(
        `PanelBridge ${status.installed ? "updated" : "installed"} at ${result.targetPath} (v${result.version || "unknown"})`,
      );
    } else {
      log.warn(`PanelBridge auto-install failed: ${result.error}`);
    }
  } catch (error) {
    log.warn(`PanelBridge auto-install check failed: ${error.message}`);
  }
}

function normalizeMemoryGb(value, fallback) {
  const parsed = parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return fallback;
  if (parsed > 128) {
    return Math.max(1, Math.round(parsed / 1024));
  }
  return parsed;
}

// Helper: Parse INI file
function parseIni(content) {
  const result = {};
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith(";"))
      continue;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.substring(0, eqIndex).trim();
      const value = trimmed.substring(eqIndex + 1).trim();
      result[key] = value;
    }
  }
  return result;
}

// Helper: Recursively scan for PZ server paths (max depth 3)
function scanForPzPaths(rootPath, maxDepth = 3) {
  const results = {
    installPaths: [], // Folders containing PZ server startup scripts
    dataPaths: [], // Folders containing Server/ subfolder with .ini files
    customBatFiles: [], // Custom startup scripts found
  };

  function scan(currentPath, depth) {
    if (depth > maxDepth) return;

    try {
      if (
        !fs.existsSync(currentPath) ||
        !fs.statSync(currentPath).isDirectory()
      )
        return;

      const items = fs.readdirSync(currentPath);

      // Check if this is an install path (has startup script or jre64)
      if (
        items.includes("StartServer64.bat") ||
        items.includes("StartServer64_nosteam.bat") ||
        items.includes("start-server.sh") ||
        (items.includes("jre64") && items.includes("ProjectZomboid64.json"))
      ) {
        results.installPaths.push(currentPath);

        // Also look for custom startup scripts
        const customScripts = items.filter(
          (f) =>
            (f.startsWith("StartServer_") && f.endsWith(".bat")) ||
            (f.startsWith("StartServer64_") &&
              f.endsWith(".bat") &&
              f !== "StartServer64_nosteam.bat") ||
            (f.startsWith("StartServer_") && f.endsWith(".sh")) ||
            (f.startsWith("start-server-") && f.endsWith(".sh")),
        );
        for (const script of customScripts) {
          // Extract server name from script file name (e.g., StartServer_DoomerZ.bat -> DoomerZ)
          let serverName = script
            .replace(/^StartServer(64)?_/, "")
            .replace(/^start-server-/, "")
            .replace(/\.(bat|sh)$/, "");
          results.customBatFiles.push({
            path: path.join(currentPath, script),
            folder: currentPath,
            fileName: script,
            serverName: serverName,
          });
        }
      }

      // Check if this is a data path (has Server/ subfolder with .ini files)
      if (items.includes("Server")) {
        const serverPath = path.join(currentPath, "Server");
        if (
          fs.existsSync(serverPath) &&
          fs.statSync(serverPath).isDirectory()
        ) {
          const serverFiles = fs.readdirSync(serverPath);
          // Look for .ini files that don't end with known suffixes like _SandboxVars, _spawnpoints, _spawnregions
          const hasIni = serverFiles.some(
            (f) =>
              f.endsWith(".ini") &&
              !f.endsWith("_SandboxVars.ini") &&
              !f.endsWith("_spawnpoints.ini") &&
              !f.endsWith("_spawnregions.ini"),
          );
          if (hasIni) {
            results.dataPaths.push(currentPath);
          }
        }
      }

      // Recurse into subdirectories (skip common non-relevant folders)
      const skipFolders = [
        "node_modules",
        ".git",
        "logs",
        "Logs",
        "cache",
        "Saves",
        "mods",
        "steamapps",
        "depotcache",
        "appcache",
        "userdata",
        "media",
      ];
      for (const item of items) {
        if (skipFolders.includes(item)) continue;
        const itemPath = path.join(currentPath, item);
        try {
          if (fs.statSync(itemPath).isDirectory()) {
            scan(itemPath, depth + 1);
          }
        } catch (e) {
          log.debug(`Skipping inaccessible path ${itemPath}: ${e.message}`);
        }
      }
    } catch (e) {
      log.debug(`Skipping inaccessible folder ${currentPath}: ${e.message}`);
    }
  }

  scan(rootPath, 0);
  return results;
}

// Auto-scan a folder to find PZ server install paths and data paths
// Reads arbitrary local server .ini files and returns their RCON passwords
// in plaintext to prefill the "create server" form — admin-only, same
// sensitivity tier as chunks delete / panel-bridge command execution.
router.post("/auto-scan", requireRole("admin"), async (req, res) => {
  try {
    const { scanPath, maxDepth = 3 } = req.body;

    if (!scanPath) {
      return res.status(400).json({ error: "Scan path is required" });
    }

    // Validate scanPath - must be an absolute path
    if (typeof scanPath !== "string" || scanPath.length > 500) {
      return res.status(400).json({ error: "Invalid path format" });
    }

    const resolvedPath = path.resolve(scanPath);

    // Must be an absolute path
    if (!path.isAbsolute(resolvedPath)) {
      return res.status(400).json({ error: "Must be an absolute path" });
    }

    // Block scanning root paths directly — require at least one subfolder
    const isRootPath =
      process.platform === "win32"
        ? /^[A-Za-z]:[\\/]?$/.test(resolvedPath)
        : resolvedPath === "/";
    if (isRootPath) {
      return res
        .status(400)
        .json({
          error: "Cannot scan a root path. Please specify a subfolder.",
        });
    }

    if (!fs.existsSync(resolvedPath)) {
      return res.status(400).json({ error: "Path does not exist" });
    }

    log.info(`Auto-scanning for PZ servers in: ${resolvedPath}`);

    const clampedDepth = Math.min(Math.max(parseInt(maxDepth, 10) || 3, 1), 3);
    const results = scanForPzPaths(resolvedPath, clampedDepth);

    // For each data path, detect the server configs
    const detectedConfigs = [];
    for (const dataPath of results.dataPaths) {
      const serverConfigPath = path.join(dataPath, "Server");
      const files = fs.readdirSync(serverConfigPath);
      // Filter for server .ini files (exclude _SandboxVars, _spawnpoints, _spawnregions)
      const iniFiles = files.filter(
        (f) =>
          f.endsWith(".ini") &&
          !f.endsWith("_SandboxVars.ini") &&
          !f.endsWith("_spawnpoints.ini") &&
          !f.endsWith("_spawnregions.ini"),
      );

      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace(".ini", "");
        const iniPath = path.join(serverConfigPath, iniFile);

        try {
          const content = fs
            .readFileSync(iniPath, "utf-8")
            .replace(/\r\n/g, "\n");
          const settings = parseIni(content);

          // Try to find a matching custom bat file for this server
          const matchingBat = results.customBatFiles.find(
            (bat) =>
              serverName.toLowerCase().includes(bat.serverName.toLowerCase()) ||
              bat.serverName.toLowerCase().includes(serverName.toLowerCase()),
          );

          detectedConfigs.push({
            dataPath,
            serverConfigPath,
            serverName,
            iniFile,
            rconPort: parseInt(settings.RCONPort, 10) || 27015,
            rconPassword: settings.RCONPassword || "",
            serverPort: parseInt(settings.DefaultPort, 10) || 16261,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
            // New: matched bat file info
            matchedBatFile: matchingBat ? matchingBat.path : null,
            matchedInstallPath: matchingBat ? matchingBat.folder : null,
          });
        } catch (err) {
          log.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }

    log.info(
      `Found ${results.installPaths.length} install paths, ${results.dataPaths.length} data paths, ${detectedConfigs.length} server configs, ${results.customBatFiles.length} custom bat files`,
    );

    res.json({
      scanPath,
      installPaths: results.installPaths,
      dataPaths: results.dataPaths,
      customBatFiles: results.customBatFiles,
      detectedConfigs,
    });
  } catch (error) {
    log.error(`Failed to auto-scan: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Detect server settings from data path (folder containing Server/, Saves/, Logs/)
// Same as /auto-scan: exposes RCON passwords read straight off disk.
router.post("/detect", requireRole("admin"), async (req, res) => {
  try {
    const { dataPath, installPath } = req.body;
    log.info(
      `POST /detect: dataPath=${dataPath}, installPath=${installPath || "auto"}`,
    );

    if (!dataPath) {
      return res.status(400).json({ error: "Data path is required" });
    }

    // Validate path format
    if (typeof dataPath !== "string" || dataPath.length > 500) {
      return res.status(400).json({ error: "Invalid path format" });
    }

    // Must be absolute
    const resolvedData = path.resolve(dataPath);
    if (!path.isAbsolute(resolvedData)) {
      return res.status(400).json({ error: "Must be an absolute path" });
    }

    // Verify data path exists
    if (!fs.existsSync(resolvedData)) {
      return res.status(400).json({ error: "Data path does not exist" });
    }

    // Check if this is a valid Zomboid data folder (should have Server subfolder)
    const serverConfigPath = path.join(resolvedData, "Server");
    if (!fs.existsSync(serverConfigPath)) {
      return res
        .status(400)
        .json({
          error: "Not a valid Zomboid data folder (no Server subfolder found)",
        });
    }

    // Validate installPath if provided
    let resolvedInstall = null;
    let hasNoSteam = false;
    let validInstallPath = false;
    if (installPath) {
      if (typeof installPath !== "string" || installPath.length > 500) {
        return res.status(400).json({ error: "Invalid install path format" });
      }
      resolvedInstall = path.resolve(installPath);
      if (fs.existsSync(resolvedInstall)) {
        const startBat = path.join(resolvedInstall, "StartServer64.bat");
        const startBatNoSteam = path.join(
          resolvedInstall,
          "StartServer64_nosteam.bat",
        );
        const startSh = path.join(resolvedInstall, "start-server.sh");
        validInstallPath =
          fs.existsSync(startBat) ||
          fs.existsSync(startBatNoSteam) ||
          fs.existsSync(startSh);
        hasNoSteam = fs.existsSync(startBatNoSteam);
      }
    }

    // Find server INI files
    const detectedServers = [];

    if (fs.existsSync(serverConfigPath)) {
      const files = fs.readdirSync(serverConfigPath);
      // Filter for server .ini files (exclude _SandboxVars, _spawnpoints, _spawnregions)
      const iniFiles = files.filter(
        (f) =>
          f.endsWith(".ini") &&
          !f.endsWith("_SandboxVars.ini") &&
          !f.endsWith("_spawnpoints.ini") &&
          !f.endsWith("_spawnregions.ini"),
      );

      for (const iniFile of iniFiles) {
        const serverName = iniFile.replace(".ini", "");
        const iniPath = path.join(serverConfigPath, iniFile);

        try {
          const content = fs
            .readFileSync(iniPath, "utf-8")
            .replace(/\r\n/g, "\n");
          const settings = parseIni(content);

          detectedServers.push({
            serverName,
            iniFile,
            rconPort: parseInt(settings.RCONPort, 10) || 27015,
            rconPassword: settings.RCONPassword || "",
            serverPort: parseInt(settings.DefaultPort, 10) || 16261,
            publicName: settings.PublicName || serverName,
            hasRcon: !!settings.RCONPassword,
          });
        } catch (err) {
          log.warn(`Failed to parse ${iniFile}: ${err.message}`);
        }
      }
    }

    res.json({
      valid: true,
      dataPath: resolvedData,
      serverConfigPath,
      installPath: resolvedInstall || "",
      validInstallPath,
      hasNoSteam,
      detectedServers,
    });
  } catch (error) {
    log.error(`Failed to detect server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get all servers
router.get("/", async (req, res) => {
  try {
    const servers = await getServers();
    res.json({ servers: sanitizeServerResponseList(servers) });
  } catch (error) {
    log.error(`Failed to get servers: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Per-server running status. Scans the host once for all PZ server processes
// and attributes each match to a configured server by comparing its install
// path against the process command line. Servers with no matching process
// are reported as not running. The active server's state is reported by
// serverManager directly so it stays consistent with /api/server/status.
router.get("/status", async (req, res) => {
  try {
    const serverManager = req.app.get("serverManager");
    const servers = await getServers();
    const activeServer = await getActiveServer();
    const activeId = activeServer?.id || null;

    let matched = [];
    let detectionError = null;
    if (serverManager?.getServerProcessDetails) {
      try {
        const result = await serverManager.getServerProcessDetails();
        matched = Array.isArray(result?.matched) ? result.matched : [];
      } catch (err) {
        detectionError = err.message;
        log.debug(`Per-server status detection failed: ${err.message}`);
      }
    }

    // Normalise install paths for comparison: lowercase + forward slashes.
    // Windows command lines may double-quote the path or use backslashes;
    // the substring check below covers both.
    const norm = (p) =>
      String(p || "")
        .toLowerCase()
        .replace(/\\/g, "/")
        .trim();

    const statuses = servers.map((server) => {
      const installPathNorm = norm(server.installPath);
      let running = false;
      let pid;
      if (installPathNorm) {
        for (const m of matched) {
          if (norm(m.cmd).includes(installPathNorm)) {
            running = true;
            pid = m.pid;
            break;
          }
        }
      }
      // Fallback: the active server's running state is authoritative even
      // when the install path doesn't appear in the command line (e.g. when
      // the process was started outside the panel and uses a different
      // working directory).
      if (!running && server.id === activeId && serverManager?.isRunning) {
        running = true;
      }
      return {
        id: server.id,
        name: server.name,
        running,
        pid: pid || null,
        isActive: server.id === activeId,
      };
    });

    res.json({
      servers: statuses,
      detectedProcesses: matched.length,
      detectionError,
    });
  } catch (error) {
    log.error(`Failed to get per-server status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Lightweight, bounded RCON connectivity probe for every configured server.
// It creates no persistent connections and never returns credential material.
router.get("/rcon-status", async (req, res) => {
  try {
    const servers = await getServers();
    const statuses = await mapWithConcurrency(servers, 3, async (server) => {
      if (!server.rconHost || !server.rconPort) {
        return { id: server.id, status: "unconfigured" };
      }
      const result = await testRconConnection({
        host: normalizeRconHost(server.rconHost),
        port: Number(server.rconPort),
        password: server.rconPassword || "",
        timeoutMs: 3000,
      });
      return {
        id: server.id,
        status: result.success ? "connected" : result.error || "unavailable",
      };
    });
    res.json({ servers: statuses });
  } catch (error) {
    log.error(`Failed to probe server RCON status: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get active server
router.get("/active", async (req, res) => {
  try {
    const server = await getActiveServer();
    if (!server) {
      return res.status(404).json({ error: "No active server configured" });
    }
    // Lets the UI stop hiding file-based pages once a remote server's Server
    // folder is reachable over SFTP.
    const remoteConfigConfigured = server.isRemote
      ? isRemoteConfigConfigured(await getAllSettings())
      : false;
    res.json({
      server: sanitizeServerResponse({ ...server, remoteConfigConfigured }),
    });
  } catch (error) {
    log.error(`Failed to get active server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get a specific server
router.get("/:id", async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);

    const server = await getServer(serverId);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    res.json({ server: sanitizeServerResponse(server) });
  } catch (error) {
    log.error(`Failed to get server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Create a new server
router.post("/", requireRole("admin"), async (req, res) => {
  try {
    const config = req.body;
    log.info(
      `POST / — creating server: name=${config?.name}, remote=${!!config?.isRemote}`,
    );

    // Fall back to env-configured paths (docker-compose PZ_SERVER_PATH /
    // PZ_SAVE_PATH) when the request body doesn't set them explicitly.
    if (!config.installPath)
      config.installPath = process.env.PZ_SERVER_PATH || "";
    if (!config.zomboidDataPath)
      config.zomboidDataPath = process.env.PZ_SAVE_PATH || null;

    // Validate required fields - installPath not required for remote servers
    const isRemote = !!config.isRemote;
    const requiredFields = isRemote
      ? ["name", "rconHost", "rconPort", "rconPassword"]
      : ["name", "installPath", "rconHost", "rconPort", "rconPassword"];
    for (const field of requiredFields) {
      if (!config[field]) {
        return res
          .status(400)
          .json({ error: `Missing required field: ${field}` });
      }
    }

    // Validate display name length
    if (typeof config.name !== "string" || config.name.length > 100) {
      return res
        .status(400)
        .json({ error: "Server name must be under 100 characters" });
    }

    // Validate RCON port
    const rconPort = parseInt(config.rconPort, 10);
    if (isNaN(rconPort) || rconPort < 1 || rconPort > 65535) {
      return res.status(400).json({ error: "Invalid RCON port" });
    }

    // Validate serverName against path traversal
    const serverName = (config.serverName || "servertest").trim();
    if (!isValidServerName(serverName)) {
      return res
        .status(400)
        .json({
          error:
            "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed",
        });
    }
    const dockerContainerName = String(config.dockerContainerName || "").trim();
    if (dockerContainerName && !isValidDockerContainerRef(dockerContainerName)) {
      return res.status(400).json({ error: "Invalid Docker container name" });
    }

    // Validate server port if provided
    if (config.serverPort) {
      const serverPort = parseInt(config.serverPort, 10);
      if (isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
        return res.status(400).json({ error: "Invalid server port" });
      }
    }

    const server = await createServer({
      name: config.name,
      serverName: config.serverName || "servertest",
      installPath: config.installPath || "",
      zomboidDataPath: config.zomboidDataPath || null,
      serverConfigPath: config.serverConfigPath || null,
      dockerContainerName: dockerContainerName || null,
      branch: config.branch || "stable",
      rconHost: normalizeRconHost(config.rconHost),
      rconPort: rconPort,
      rconPassword: config.rconPassword,
      adminPassword: config.adminPassword || "",
      serverPort: parseInt(config.serverPort, 10) || 16261,
      minMemory: normalizeMemoryGb(config.minMemory, 4),
      maxMemory: normalizeMemoryGb(config.maxMemory, 8),
      useNoSteam: !!config.useNoSteam,
      useDebug: !!config.useDebug,
      isRemote: isRemote,
    });

    log.info(`Created new server: ${server.name} (ID: ${server.id})`);
    res.status(201).json({
      server: sanitizeServerResponse(server),
      message: "Server created successfully",
    });
  } catch (error) {
    log.error(`Failed to create server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Allowed fields for server update — prevents mass assignment of internal fields (id, isActive, etc.)
const ALLOWED_SERVER_UPDATE_FIELDS = [
  "name",
  "serverName",
  "installPath",
  "serverPath",
  "zomboidDataPath",
  "serverConfigPath",
  "dockerContainerName",
  "branch",
  "rconHost",
  "rconPort",
  "rconPassword",
  "serverPort",
  "minMemory",
  "maxMemory",
  "useNoSteam",
  "useDebug",
  "isRemote",
  "startBat",
  "batFile",
  "description",
  "adminPassword",
];

// Update a server
router.put("/:id", requireRole("admin"), async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);

    // Only allow whitelisted fields — block id, isActive, created, etc.
    const updates = {};
    for (const key of ALLOWED_SERVER_UPDATE_FIELDS) {
      if (req.body[key] !== undefined) {
        updates[key] = req.body[key];
      }
    }

    // Validate serverName against path traversal — this field is
    // interpolated into filesystem paths downstream (server-files, backups,
    // chunks), so it must pass the same check as server creation.
    if (updates.serverName !== undefined) {
      const trimmed = String(updates.serverName).trim();
      if (!isValidServerName(trimmed)) {
        return res.status(400).json({
          error:
            "Invalid server name: only letters, numbers, underscores, hyphens and spaces allowed",
        });
      }
      updates.serverName = trimmed;
    }

    if (updates.dockerContainerName !== undefined) {
      const value = String(updates.dockerContainerName).trim();
      if (value && !isValidDockerContainerRef(value)) {
        return res.status(400).json({
          error: "Invalid Docker container name",
        });
      }
      updates.dockerContainerName = value || null;
    }

    // GET responses mask rconPassword/adminPassword (sanitizeServerResponse).
    // If the client echoes that masked value back unmodified, drop the field
    // so the real stored secret isn't overwritten with bullets.
    for (const key of ["rconPassword", "adminPassword"]) {
      if (updates[key] !== undefined && isMaskedSecret(updates[key])) {
        delete updates[key];
      }
    }

    if (updates.rconHost !== undefined) {
      updates.rconHost = normalizeRconHost(updates.rconHost);
    }

    // Validate RCON port if provided
    if (updates.rconPort !== undefined) {
      const rconPort = parseInt(updates.rconPort, 10);
      if (isNaN(rconPort) || rconPort < 1 || rconPort > 65535) {
        return res.status(400).json({ error: "Invalid RCON port" });
      }
      updates.rconPort = rconPort;
    }

    // Validate server port if provided
    if (updates.serverPort !== undefined) {
      const serverPort = parseInt(updates.serverPort, 10);
      if (isNaN(serverPort) || serverPort < 1 || serverPort > 65535) {
        return res.status(400).json({ error: "Invalid server port" });
      }
      updates.serverPort = serverPort;
    }

    // Parse numeric fields
    if (updates.minMemory !== undefined) {
      updates.minMemory = normalizeMemoryGb(updates.minMemory, 4);
    }
    if (updates.maxMemory !== undefined) {
      updates.maxMemory = normalizeMemoryGb(updates.maxMemory, 8);
    }

    // Parse boolean fields
    if (updates.useNoSteam !== undefined) {
      updates.useNoSteam = !!updates.useNoSteam;
    }
    if (updates.useDebug !== undefined) {
      updates.useDebug = !!updates.useDebug;
    }

    const server = await updateServer(serverId, updates);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    log.info(`Updated server: ${server.name} (ID: ${server.id})`);

    // If the active server's RCON settings changed, refresh the RCON service
    // Otherwise the service keeps stale cached credentials after a reconnect
    if (server.isActive) {
      const rconFieldsChanged = ["rconHost", "rconPort", "rconPassword"].some(
        (k) => Object.prototype.hasOwnProperty.call(updates, k),
      );
      const serverManagerFieldsChanged = [
        "installPath",
        "serverPath",
        "zomboidDataPath",
        "serverConfigPath",
        "branch",
        "serverPort",
        "minMemory",
        "maxMemory",
        "useNoSteam",
        "useDebug",
        "startBat",
        "batFile",
        "serverName",
      ].some((k) => Object.prototype.hasOwnProperty.call(updates, k));

      const rconService = req.app.get("rconService");
      const serverManager = req.app.get("serverManager");

      if (serverManagerFieldsChanged && serverManager?.reloadConfig) {
        try {
          await serverManager.reloadConfig();
          log.info(`ServerManager config refreshed after active server update`);
        } catch (e) {
          log.warn(`ServerManager reload failed after update: ${e.message}`);
        }
      }

      if (rconFieldsChanged && rconService?.reloadConfig) {
        try {
          if (rconService.isConnected && rconService.isConnected()) {
            await rconService.disconnect();
          }
          await rconService.reloadConfig();
          // Try to reconnect in background; auto-reconnect will also keep trying
          rconService.connect().catch(() => {});
          log.info(`RCON config refreshed after active server update`);
        } catch (e) {
          log.warn(`RCON reload failed after update: ${e.message}`);
        }
      }
    }

    res.json({
      server: sanitizeServerResponse(server),
      message: "Server updated successfully",
    });
  } catch (error) {
    log.error(`Failed to update server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Delete a server
router.delete("/:id", requireRole("admin"), async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);

    const success = await deleteServer(serverId);
    if (!success) {
      return res.status(404).json({ error: "Server not found" });
    }

    // Notify all clients so sidebar refreshes
    const io = req.app.get("io");
    if (io) {
      io.emit("activeServerChanged", { deleted: serverId });
    }

    log.info(`Deleted server ID: ${serverId}`);
    res.json({ success: true, message: "Server deleted successfully" });
  } catch (error) {
    log.error(`Failed to delete server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Set active server
router.post("/:id/activate", requireRole("admin"), async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) {
      return res.status(400).json({ error: "Invalid server ID" });
    }
    // Check if ID looks like a UUID (contains dashes or letters beyond valid decimal digits)
    const isUUID = /[a-f-]/i.test(id);
    const serverId = isUUID ? id : parseInt(id, 10);

    const server = await setActiveServer(serverId);
    if (!server) {
      return res.status(404).json({ error: "Server not found" });
    }

    // Notify services about the active server change
    const rconService = req.app.get("rconService");
    const serverManager = req.app.get("serverManager");
    const io = req.app.get("io");

    // Reload ServerManager config for new active server
    if (serverManager && serverManager.reloadConfig) {
      await serverManager.reloadConfig();
      log.info(`ServerManager reloaded config for server: ${server.name}`);
    }

    // Disconnect current RCON if connected
    if (rconService && rconService.isConnected()) {
      await rconService.disconnect();
    }

    // Reload RCON config and reconnect with new server's settings
    if (rconService && server.rconPassword) {
      try {
        await rconService.reloadConfig();
        await rconService.connect();
        log.info(`RCON reconnected for server: ${server.name}`);
      } catch (rconErr) {
        log.warn(`Failed to connect RCON for new server: ${rconErr.message}`);
      }
    }

    // Best-effort: keep PanelBridge.lua current on servers the panel can
    // reach directly on disk. Never let an install failure block activation.
    autoInstallBridgeIfNeeded(server);

    // Emit to clients that active server changed
    if (io) {
      io.emit("activeServerChanged", { server });
    }

    log.info(`Activated server: ${server.name} (ID: ${server.id})`);
    res.json({
      server: sanitizeServerResponse(server),
      message: `Now managing: ${server.name}`,
    });
  } catch (error) {
    log.error(`Failed to activate server: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
