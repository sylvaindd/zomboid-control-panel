import express from 'express';
import { createLogger } from '../utils/logger.js';
const log = createLogger('API:RCON');
import { getCommandHistory } from '../database/init.js';
import { PZ_COMMANDS } from '../utils/commands.js';
import { sanitizeError } from '../utils/sanitize.js';
import { testRconConnection } from '../services/rcon.js';
import { requireRole, requirePermission } from '../services/auth.js';

const router = express.Router();

function validateTestInput(host, port, password) {
  if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    return 'Invalid host format';
  }
  const portNum = parseInt(port, 10);
  if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
    return 'Invalid port (1-65535)';
  }
  if (password !== undefined && (typeof password !== 'string' || password.length > 256)) {
    return 'Invalid password format';
  }
  return null;
}

// Execute raw RCON command.
// Operator-configurable, but defaults to admin: this takes an arbitrary
// string straight to RCON, so whoever holds it can run quit, additem,
// grantadmin or banid regardless of what the panel UI exposes.
router.post('/execute', requirePermission('rcon.execute'), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { command } = req.body;
    log.info(`POST /execute: ${(command || '').substring(0, 100)}`);
    
    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }
    
    // Validate command type and length
    if (typeof command !== 'string' || command.length > 2000) {
      return res.status(400).json({ error: 'Invalid command (max 2000 characters)' });
    }
    
    const result = await rconService.execute(command);
    
    // Emit to connected clients
    const io = req.app.get('io');
    if (io) io.to('logs').emit('rcon:response', {
      command,
      response: result.response || result.error,
      success: result.success,
      timestamp: new Date().toISOString()
    });
    
    res.json(result);
  } catch (error) {
    log.error(`RCON execute failed: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get RCON connection status
router.get('/status', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const config = rconService.getConfig();
    res.json(config);
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Connect to RCON. Admin-only regardless of rcon.execute: this rewrites the
// panel's stored RCON host/port/password, which is connection configuration
// rather than in-game command execution.
router.post('/connect', requireRole('admin'), async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const { host, port, password } = req.body;
    log.info(`POST /connect (host=${host || 'default'}, port=${port || 'default'}, password=${password ? '***' : 'none'})`);
    
    // Validate host format if provided (only alphanumeric, dots, hyphens)
    if (host !== undefined) {
      if (typeof host !== 'string' || host.length > 255 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
        return res.status(400).json({ success: false, error: 'Invalid host format' });
      }
    }
    
    // Validate port if provided
    if (port !== undefined) {
      const portNum = parseInt(port, 10);
      if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return res.status(400).json({ success: false, error: 'Invalid port (1-65535)' });
      }
    }
    
    // Validate password if provided
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length > 256) {
        return res.status(400).json({ success: false, error: 'Invalid password format' });
      }
    }
    
    if (host || port || password) {
      rconService.updateConfig(host, port, password);
    }
    
    const connected = await rconService.connect();
    if (connected) {
      res.json({ success: true, message: 'Connected to RCON' });
    } else {
      res.status(503).json({ success: false, error: 'Could not connect to RCON. Is the server running and RCON enabled?' });
    }
  } catch (error) {
    log.error(`RCON connect failed: ${error.message}`);
    const rconService = req.app.get('rconService');
    const friendlyError = rconService.getUserFriendlyError(error.message);
    res.status(500).json({ success: false, error: friendlyError });
  }
});

// Test arbitrary RCON credentials without applying them — lets the UI
// validate host/port/password before the user saves a server's settings.
router.post('/test', requireRole('admin'), async (req, res) => {
  try {
    const { host, port, password } = req.body;
    log.info(`POST /test (host=${host || 'none'}, port=${port || 'none'})`);

    const validationError = validateTestInput(host, port, password);
    if (validationError) {
      return res.status(400).json({ success: false, error: 'invalid_input', detail: validationError });
    }

    const result = await testRconConnection({ host, port: parseInt(port, 10), password });
    res.json(result);
  } catch (error) {
    log.error(`RCON test failed: ${error.message}`);
    res.status(500).json({ success: false, error: 'internal_error', detail: sanitizeError(error.message) });
  }
});

// Health check - test if connection is actually alive
router.get('/health', async (req, res) => {
  try {
    const rconService = req.app.get('rconService');
    const health = await rconService.healthCheck();
    if (health.healthy) {
      res.json({ success: true, ...health });
    } else {
      res.status(503).json({ success: false, ...health });
    }
  } catch (error) {
    res.status(500).json({ success: false, reason: sanitizeError(error.message) });
  }
});

// Disconnect from RCON
router.post('/disconnect', requireRole('admin'), async (req, res) => {
  try {
    log.info('POST /disconnect');
    const rconService = req.app.get('rconService');
    await rconService.disconnect();
    res.json({ success: true, message: 'Disconnected from RCON' });
  } catch (error) {
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get command history
router.get('/history', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
    const history = await getCommandHistory(limit);
    res.json({ history });
  } catch (error) {
    log.error(`Failed to get command history: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Get available commands
router.get('/commands', (req, res) => {
  res.json({ commands: PZ_COMMANDS });
});

// Get commands by category
router.get('/commands/:category', (req, res) => {
  const { category } = req.params;
  const filtered = Object.entries(PZ_COMMANDS)
    .filter(([_, cmd]) => cmd.category === category)
    .reduce((acc, [key, cmd]) => {
      acc[key] = cmd;
      return acc;
    }, {});
  
  res.json({ commands: filtered });
});

export default router;
