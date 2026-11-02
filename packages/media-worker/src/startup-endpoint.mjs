// Startup endpoint resolution for the worker server.
//
// Plain `.mjs` with no imports so a container that only has Node itself can
// load it before any dependency is installed: the endpoint is resolved and
// logged even when the rest of the service cannot start.

const DEFAULT_WORKER_PORT = 8787;
const DEFAULT_WORKER_HOST = '127.0.0.1';

function describeValue(value) {
  if (value === undefined) return 'unset';
  if (value === '') return 'empty';
  if (/^\s+$/.test(value)) return 'whitespace-only';
  return `"${value.length > 16 ? `${value.slice(0, 16)}…` : value}"`;
}

export function parseWorkerPort(raw, source) {
  if (raw === undefined || raw.trim() === '') return null;
  const text = raw.trim();
  const value = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${source}=${describeValue(raw)} is not a valid TCP port (expected an integer 1-65535)`);
  }
  return value;
}

/**
 * Resolves the worker bind endpoint.
 *
 * Precedence: SERVER_PORT (a platform-assigned published port) →
 * MEDIA_WORKER_PORT (existing deployments) → PORT (generic) → 8787.
 * A value that is set but unusable throws instead of silently binding a
 * different port, because a silent fallback is indistinguishable from success.
 */
export function resolveWorkerEndpoint(env = process.env, { defaultPort = DEFAULT_WORKER_PORT, defaultHost = DEFAULT_WORKER_HOST } = {}) {
  if (env.MEDIA_WORKER_NO_LISTEN === '1') return { listen: false, port: null, host: null, source: null };
  const candidates = [
    ['SERVER_PORT', env.SERVER_PORT],
    ['MEDIA_WORKER_PORT', env.MEDIA_WORKER_PORT],
    ['PORT', env.PORT],
  ];
  for (const [source, raw] of candidates) {
    const port = parseWorkerPort(raw, source);
    if (port !== null) return { listen: true, port, host: resolveWorkerHost(env, defaultHost), hostSource: describeHostSource(env), source };
  }
  return { listen: true, port: defaultPort, host: resolveWorkerHost(env, defaultHost), hostSource: describeHostSource(env), source: 'default' };
}

// Invisible characters a console/paste round trip can leave in a value; `trim()`
// only removes ASCII whitespace, and these make the printed host disagree with
// the address Node actually binds.
const INVISIBLE = /[\u200B-\u200D\u2060\uFEFF\u00A0\r]/g;

// A host on the public interface is only chosen when an explicit
// MEDIA_WORKER_HOST says so, or when the platform published the port itself
// through SERVER_PORT (the platform assigns the port the workload is reachable on).
// Local development has no SERVER_PORT and keeps its loopback default.
const PLATFORM_PUBLISHED_HOST = '0.0.0.0';

/** Where the bind host came from, for the startup log only. */
export function describeHostSource(env = process.env) {
  const explicit = String(env.MEDIA_WORKER_HOST ?? '').replace(INVISIBLE, '').trim();
  if (explicit) return 'MEDIA_WORKER_HOST';
  try {
    if (parseWorkerPort(env.SERVER_PORT, 'SERVER_PORT') !== null) return 'SERVER_PORT (platform-published)';
  } catch {
    return 'default';
  }
  return 'default';
}

export function resolveWorkerHost(env = process.env, fallback = DEFAULT_WORKER_HOST) {
  const explicit = String(env.MEDIA_WORKER_HOST ?? '').replace(INVISIBLE, '').trim();
  if (explicit) return explicit;
  try {
    if (parseWorkerPort(env.SERVER_PORT, 'SERVER_PORT') !== null) return PLATFORM_PUBLISHED_HOST;
  } catch {
    // An unusable SERVER_PORT is reported by resolveWorkerEndpoint, not here.
  }
  return fallback;
}

/**
 * Describes the environment the process actually received, so a platform that
 * does not inject a saved value is visible in the log instead of inferred from
 * a fallback. Only the bind endpoint variables are reported, never a secret.
 */
export function describeWorkerEnvironment(env = process.env) {
  const show = (name) => {
    const value = env[name];
    if (value === undefined) return `${name}=unset`;
    if (value === '') return `${name}=empty`;
    const host = name === 'MEDIA_WORKER_HOST';
    const printable = host ? String(value).replace(INVISIBLE, '') : value;
    const same = String(value) === printable;
    const rendered = printable.length > 24 ? `${printable.slice(0, 24)}…` : printable;
    return `${name}="${rendered}"${same ? '' : ' (invisible characters removed)'}`;
  };
  return ['MEDIA_WORKER_HOST', 'MEDIA_WORKER_PORT', 'SERVER_PORT'].map(show).join(', ');
}

/**
 * Describes the endpoint for one startup line. Values are printed, secrets are
 * not: the only environment reads are the port/host variables themselves.
 */
export function describeWorkerEndpoint({ port, host, source }) {
  return `Media worker listening on http://${host}:${port} (port from ${source})`;
}

/**
 * Binds and makes the outcome visible. `server.listen` errors (EADDRINUSE,
 * EACCES, EADDRNOTAVAIL) are emitted as `error` events; without a listener they
 * become an uncaught exception whose stack does not name the worker.
 */
export function listenWithReporting(server, { port, host, source, hostSource, log = console.log, logError = console.error, exit = (code) => process.exit(code) }) {
  server.once('listening', () => {
    // The bound address comes from the server itself, not from the requested
    // values, so the line cannot disagree with what Node actually bound.
    const bound = server.address();
    const address = bound && typeof bound === 'object' ? bound.address : host;
    const boundPort = bound && typeof bound === 'object' ? bound.port : port;
    const origin = hostSource ? `, host from ${hostSource}` : '';
    log(`${describeWorkerEndpoint({ port: boundPort, host: address, source })}${origin} env: ${describeWorkerEnvironment()}`);
  });
  server.once('error', (error) => {
    const code = error?.code ?? 'UNKNOWN';
    logError(`Media worker failed to bind ${host}:${port} (port from ${source}): ${code} ${error?.message ?? error}`);
    process.exitCode = 1;
    server.close(() => exit(1));
  });
  server.listen(port, host);
  return server;
}
