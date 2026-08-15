import { describe, expect, it } from 'vitest';
import net from 'net';
import { testRconConnection } from '../services/rcon.js';
import router from '../routes/rcon.js';

function createResponse() {
  const response = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

function getTestHandler() {
  const layer = router.stack.find(
    (entry) => entry.route?.path === '/test' && entry.route.methods.post,
  );
  // The first stack entry is now an authorization middleware; these tests
  // target the business-logic handler, so take the last one. Authorization
  // itself is covered by the dedicated role-rejection suites.
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

describe('testRconConnection', () => {
  it('returns unreachable when the TCP connection cannot be established', async () => {
    // Nothing listens on this loopback port in the test environment, so the
    // connection is refused (or times out) rather than authenticating.
    const result = await testRconConnection({
      host: '127.0.0.1',
      port: 39822,
      password: 'whatever',
      timeoutMs: 1000,
    });
    expect(result).toEqual({
      success: false,
      error: 'unreachable',
      detail: 'Unreachable: check host and port',
    });
  });

  it('returns auth_failed when TCP connects but RCON auth never completes', async () => {
    // A bare TCP server that accepts the connection but never speaks the
    // RCON protocol -- authenticate() times out and rejects, exercising the
    // auth_failed branch without needing a real RCON server.
    const server = net.createServer((socket) => socket.on('data', () => {}));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
      const result = await testRconConnection({
        host: '127.0.0.1',
        port,
        password: 'wrong-password',
        timeoutMs: 300,
      });
      expect(result).toEqual({
        success: false,
        error: 'auth_failed',
        detail: 'Authentication failed: check RCON password',
      });
    } finally {
      server.close();
    }
  });
});

describe('POST /api/rcon/test route validation', () => {
  it('rejects an invalid host format with 400', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: 'not a host!', port: 27015, password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'invalid_input',
      detail: 'Invalid host format',
    });
  });

  it('rejects an out-of-range port with 400', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: 99999, password: 'x' } },
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.detail).toBe('Invalid port (1-65535)');
  });

  it('reports unreachable for a closed local port via the real handler', async () => {
    const res = createResponse();
    await getTestHandler()(
      { body: { host: '127.0.0.1', port: 39822, password: 'x' } },
      res,
    );
    expect(res.body).toEqual({
      success: false,
      error: 'unreachable',
      detail: 'Unreachable: check host and port',
    });
  });
});
