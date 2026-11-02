// Generic, lease-fenced HTTP media worker.
//
// The server owns process concerns only: endpoint resolution, authentication,
// routing, temp reaping, readiness and shutdown. Everything that depends on a
// particular coordinator — request validation against a durable lease, the work
// runner, the drain/abort protocol, FFmpeg detection and the readiness checks —
// is supplied through `createWorker(adapters)`.
//
// Contract (identical for every adapter implementation):
//   GET  /health  200, unauthenticated, body { status: 'ok', contract }
//   GET  /ready   200 when every adapter readiness check passes, else 503
//   POST /work    401 without a valid bearer token, then 202/400/409/500
//
// A delivery is answered exactly once. Validation runs before the 202; a run
// failure is logged and never re-replied, because the durable lease (not the
// HTTP reply) is the authority on the unit's outcome.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

import { cleanupStaleWorkerTempDirectories } from './temp-cleanup.mjs';
import { readDeliverableBody, runWorkHandshake, sendWorkReply, shutdownActiveRuns } from './work-handshake.mjs';
import { listenWithReporting, resolveWorkerEndpoint } from './startup-endpoint.mjs';

export const DEFAULT_CONTRACT = 'media-worker-v1';
export const MAX_REQUEST_BYTES = 256 * 1024;
/** How often a serving worker reaps stale temp directories (startup sweeps once). */
export const TEMP_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** Constant-time bearer check. An unset token is never a valid credential. */
export function createBearerAuthorizer(getToken) {
  return function authorized(request) {
    const expected = getToken() ?? '';
    const header = request.headers.authorization;
    const provided = typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7) : '';
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return Boolean(expected) && a.length === b.length && timingSafeEqual(a, b);
  };
}

const defaultLogger = {
  error: async (context, error) => console.error(`[${context}]`, error),
  info: (line) => console.log(line),
};

/**
 * Build a worker server.
 *
 * @param {object} adapters
 * @param {string} [adapters.contract]          contract version echoed by every reply
 * @param {() => string | undefined} [adapters.getToken]
 * @param {(input: { text: string, contractHeader: string | undefined }) => Promise<{ request: object, store?: unknown }>} adapters.validateRequest
 * @param {(input: { request: object, store: unknown }) => { run: Promise<unknown>, abort: (reason?: unknown) => void }} adapters.startRun
 * @param {() => Promise<Record<string, boolean>>} [adapters.readinessChecks]
 * @param {() => boolean} [adapters.isShuttingDown]
 * @param {object} [adapters.logger]
 * @param {() => Promise<number>} [adapters.sweepTemp]
 * @param {NodeJS.ProcessEnv} [adapters.env]
 * @param {boolean} [adapters.autoStart]        start listening on construction (default true)
 */
export function createWorker(adapters = {}) {
  const {
    contract = DEFAULT_CONTRACT,
    getToken = () => process.env.MEDIA_WORKER_TOKEN,
    validateRequest,
    startRun,
    readinessChecks = async () => ({ authentication: Boolean(getToken()) }),
    isShuttingDown = () => false,
    logger = defaultLogger,
    sweepTemp = () => cleanupStaleWorkerTempDirectories(),
    env = process.env,
    autoStart = true,
  } = adapters;

  if (typeof validateRequest !== 'function') throw new TypeError('createWorker requires validateRequest');
  if (typeof startRun !== 'function') throw new TypeError('createWorker requires startRun');

  const authorized = createBearerAuthorizer(getToken);
  const activeRuns = new Map();
  const sockets = new Set();
  let shuttingDown = false;
  let cleanupTimer = null;

  const reply = (response, status, body) => {
    sendWorkReply(response, status, body, { 'x-media-worker-contract': contract });
  };

  const readiness = async () => {
    let checks;
    try {
      checks = await readinessChecks();
    } catch (error) {
      checks = { readiness: false };
      await logger.error('media-worker.readiness', error);
    }
    const ready = Object.values(checks).every(Boolean);
    return { status: ready ? 'ready' : 'not_ready', contract, checks };
  };

  const server = createServer(async (request, response) => {
    if (shuttingDown) {
      reply(response, 503, { error: 'Worker is shutting down' });
      return;
    }
    if (request.method === 'GET' && request.url === '/health') {
      reply(response, 200, { status: 'ok', contract });
      return;
    }
    if (request.method === 'GET' && request.url === '/ready') {
      const status = await readiness();
      reply(response, status.status === 'ready' ? 200 : 503, status);
      return;
    }
    if (request.method !== 'POST' || request.url !== '/work') {
      reply(response, 404, { error: 'Not found' });
      return;
    }
    if (!authorized(request)) {
      reply(response, 401, { error: 'Unauthorized' });
      return;
    }
    try {
      const contractHeader = request.headers['x-media-worker-contract'];
      const { text } = await readDeliverableBody(request, MAX_REQUEST_BYTES);
      const handshake = await runWorkHandshake({
        readBody: async () => text,
        validateRequest: (delivery) => validateRequest({ ...delivery, contractHeader }),
        startRun,
        activeRuns,
        onRunError: logger.error,
      });
      reply(response, handshake.status, handshake.body);
    } catch (error) {
      await logger.error('media-worker.work.handler', error);
      reply(response, 500, { error: 'Worker request failed' });
    }
  });

  const endpoint = resolveWorkerEndpoint(env);

  // Track live sockets so a forced close during shutdown has something to
  // destroy; `server.close()` alone only settles when clients disconnect. The
  // listener is registered here, not in start(), so a worker whose server was
  // bound by its caller is tracked too.
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });

  async function start({ log, logError, exit } = {}) {
    if (!endpoint.listen) return server;
    try {
      await sweepTemp();
    } catch (error) {
      await logger.error('media-worker.temp-cleanup', error);
    }
    // A long-lived worker never exits between runs, so a startup-only sweep
    // lets crashed directories accumulate until the worker disk is full.
    cleanupTimer = setInterval(() => {
      void sweepTemp().catch((error) => logger.error('media-worker.temp-cleanup', error));
    }, TEMP_CLEANUP_INTERVAL_MS);
    cleanupTimer.unref?.();
    listenWithReporting(server, { ...endpoint, ...(log ? { log } : {}), ...(logError ? { logError } : {}), ...(exit ? { exit } : {}) });
    return server;
  }

  async function shutdown(signal = 'shutdown') {
    if (shuttingDown) return;
    shuttingDown = true;
    if (cleanupTimer) clearInterval(cleanupTimer);
    await shutdownActiveRuns(activeRuns, { reason: `Worker received ${signal}` });
    await closeServer();
  }

  /**
   * Stop accepting connections and settle once every socket is done.
   *
   * `server.close()` only invokes its callback after all connections end. A run
   * that has already stopped accepting abort signals would otherwise hold this
   * promise open forever, so connected sockets are destroyed after a bounded
   * grace period and the promise always settles.
   */
  function closeServer({ graceMs = 5_000 } = {}) {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        for (const socket of sockets) {
          try { socket.destroy(); } catch {}
        }
        finish();
      }, graceMs);
      timer.unref?.();
      try {
        server.close(finish);
      } catch {
        finish();
      }
    });
  }

  if (autoStart) void start();

  return { server, start, shutdown, closeServer, endpoint, activeRuns, isShuttingDown: () => shuttingDown };
}

// A production process starts on import; a test drives the handler in-process
// with MEDIA_WORKER_NO_LISTEN=1 and NODE_ENV=test.
export function shouldAutoStart(env = process.env) {
  return env.MEDIA_WORKER_NO_LISTEN !== '1' || env.NODE_ENV !== 'test';
}
