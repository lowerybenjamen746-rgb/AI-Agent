#!/usr/bin/env node
// Example 1 — Media Worker end to end.
//
// Starts the worker with a coordinator adapter, then exercises every documented
// endpoint including the failure paths and a graceful shutdown. Everything here
// uses the package's real exports; nothing is simulated API surface.
//
// Run from the repository root:
//   node examples/01-media-worker/run.mjs
//
// No dependencies to install: packages/media-worker has none.

import { request } from 'node:http';

import { createWorker } from '../../packages/media-worker/src/server.mjs';

const TOKEN = 'example-token-change-me';
const LEASES = new Map([['unit-1', 'lease-a']]);

const log = (label, value) => console.log(`${label.padEnd(28)} ${value}`);

/** Send one HTTP request and return { status, body }. */
function call(port, { method = 'GET', path = '/', headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const unitBody = (id, leaseToken) =>
  JSON.stringify({ unit: { id, lease: { leaseToken } } });

// ---------------------------------------------------------------------------
// Adapters: these are the only coordinator-specific parts of the worker.
// ---------------------------------------------------------------------------

const adapter = {
  // 1. Authentication boundary — the token the worker accepts.
  getToken: () => TOKEN,

  // 2. Validation runs BEFORE the 202 is written. Throw to reject with 400.
  async validateRequest({ text }) {
    const parsed = JSON.parse(text);
    const lease = LEASES.get(parsed.unit.id);
    if (lease !== parsed.unit.lease.leaseToken) throw new Error('lease does not match');
    return { request: parsed, store: { note: 'your durable store goes here' } };
  },

  // 3. The actual work. Resolving is enough for this example.
  startRun({ request: work }) {
    let cancelled = false;
    return {
      run: new Promise((resolve) => {
        const timer = setTimeout(resolve, 25);
        if (cancelled) clearTimeout(timer);
      }),
      abort: () => { cancelled = true; },
    };
  },

  // 4. Readiness → /ready returns 200 only when every check is true.
  async readinessChecks() {
    return { authentication: Boolean(TOKEN), leases: LEASES.size > 0 };
  },

  // Keep example output quiet; a real service should log these.
  logger: { error: async () => {}, info: () => {} },
};

// ---------------------------------------------------------------------------
// Run the demonstration.
// ---------------------------------------------------------------------------

const worker = createWorker({
  ...adapter,
  env: { MEDIA_WORKER_NO_LISTEN: '1' }, // this example binds its own port
  autoStart: false,
});

await new Promise((resolve) => worker.server.listen(0, '127.0.0.1', resolve));
const { port } = worker.server.address();
console.log(`Worker listening on 127.0.0.1:${port}\n`);

const auth = { authorization: `Bearer ${TOKEN}` };

// Healthy process, before any checks are exercised.
log('GET /health', JSON.stringify((await call(port, { path: '/health' })).body));

// Readiness reflects the adapter's checks.
const ready = await call(port, { path: '/ready' });
log('GET /ready', `${ready.status} ${JSON.stringify(ready.body.checks)}`);

// No token → 401, and the run never starts.
const noToken = await call(port, { method: 'POST', path: '/work', payload: unitBody('unit-1', 'lease-a') });
log('POST /work (no token)', noToken.status);

// Wrong token → 401.
const badToken = await call(port, {
  method: 'POST', path: '/work',
  headers: { authorization: 'Bearer wrong-token' },
  payload: unitBody('unit-1', 'lease-a'),
});
log('POST /work (wrong token)', badToken.status);

// Malformed JSON → 400 from validation.
const malformed = await call(port, {
  method: 'POST', path: '/work', headers: auth, payload: 'not json',
});
log('POST /work (malformed)', `${malformed.status} ${JSON.stringify(malformed.body)}`);

// Stale lease → 400 from the adapter.
const staleLease = await call(port, {
  method: 'POST', path: '/work', headers: auth, payload: unitBody('unit-1', 'wrong-lease'),
});
log('POST /work (stale lease)', staleLease.status);

// Valid delivery → 202, and the run is executed.
const accepted = await call(port, {
  method: 'POST', path: '/work', headers: auth, payload: unitBody('unit-1', 'lease-a'),
});
log('POST /work (valid)', `${accepted.status} outcome=${accepted.body.outcome}`);

// Unknown route → 404.
log('GET /nope', (await call(port, { path: '/nope' })).status);

// Graceful shutdown: refuses new deliveries, aborts in-flight runs, then closes.
await worker.shutdown('example');
const afterShutdown = await call(port, { path: '/health' }).catch(() => ({ status: 'connection refused' }));
log('GET /health after shutdown', afterShutdown.status);

console.log('\nDone. Every line above came from a real request to the worker.');
