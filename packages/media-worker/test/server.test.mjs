import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { createWorker } from '../src/server.mjs';

const TOKEN = 'test-token-not-a-secret';

function body(unitId, leaseToken) {
  return JSON.stringify({ unit: { id: unitId, lease: { leaseToken } } });
}

// Every accepted delivery must release its run, or the `/work` handler keeps
// awaiting it. Tests that do not care about the run use `immediateRun`.
function immediateRun() {
  return { run: Promise.resolve(), abort: () => {} };
}

async function startWorker(overrides = {}) {
  const worker = createWorker({
    env: { MEDIA_WORKER_NO_LISTEN: '1' },
    autoStart: false,
    getToken: () => overrides.token ?? TOKEN,
    validateRequest: overrides.validateRequest ?? (async ({ text }) => ({ request: JSON.parse(text), store: null })),
    startRun: overrides.startRun ?? immediateRun,
    readinessChecks: overrides.readinessChecks,
    logger: { error: async () => {}, info: () => {} },
  });
  await new Promise((resolve) => worker.server.listen(0, '127.0.0.1', resolve));
  const { port } = worker.server.address();
  const close = () => worker.closeServer({ graceMs: 50 });
  return { worker, port, close };
}

function call(port, { method = 'GET', path = '/', headers = {}, payload } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, json: data ? JSON.parse(data) : null }));
    });
    request.on('error', reject);
    if (payload !== undefined) request.write(payload);
    request.end();
  });
}

test('GET /health is unauthenticated and echoes the contract', async () => {
  const { port, close } = await startWorker();
  try {
    const response = await call(port, { path: '/health' });
    assert.equal(response.status, 200);
    assert.equal(response.json.status, 'ok');
    assert.equal(response.json.contract, 'media-worker-v1');
    assert.equal(response.headers['x-media-worker-contract'], 'media-worker-v1');
  } finally {
    await close();
  }
});

test('POST /work without a token is 401 and never runs', async () => {
  let started = 0;
  const { port, close } = await startWorker({ startRun: () => { started += 1; return { run: Promise.resolve(), abort: () => {} }; } });
  try {
    const missing = await call(port, { method: 'POST', path: '/work', payload: body('u1', 'l1') });
    assert.equal(missing.status, 401);
    const wrong = await call(port, { method: 'POST', path: '/work', headers: { authorization: 'Bearer nope' }, payload: body('u1', 'l1') });
    assert.equal(wrong.status, 401);
    assert.equal(started, 0);
  } finally {
    await close();
  }
});

test('POST /work with the token accepts exactly once and runs the unit', async () => {
  const { port, close } = await startWorker();
  try {
    const response = await call(port, { method: 'POST', path: '/work', headers: { authorization: `Bearer ${TOKEN}` }, payload: body('u2', 'l2') });
    assert.equal(response.status, 202);
    assert.equal(response.json.unitId, 'u2');
    assert.equal(response.json.outcome, 'accepted');
    assert.equal(response.json.resourceReceipt.requests, 0);
  } finally {
    await close();
  }
});

test('an unset token is never a valid credential, even for an empty bearer', async () => {
  const { port, close } = await startWorker({ token: '' });
  try {
    assert.equal((await call(port, { method: 'POST', path: '/work', headers: { authorization: 'Bearer ' }, payload: body('u', 'l') })).status, 401);
  } finally {
    await close();
  }
});

test('a rejected request is 400 and a validator-reported race is 409', async () => {
  const seen = new Set();
  const { port, close } = await startWorker({
    validateRequest: async ({ text, unitId }) => {
      if (seen.has(unitId)) return { duplicate: true };
      seen.add(unitId);
      return { request: JSON.parse(text), store: null };
    },
  });
  try {
    const bad = await call(port, { method: 'POST', path: '/work', headers: { authorization: `Bearer ${TOKEN}` }, payload: 'not json' });
    assert.equal(bad.status, 400);
    seen.add('u-race');
    const raced = await call(port, { method: 'POST', path: '/work', headers: { authorization: `Bearer ${TOKEN}` }, payload: body('u-race', 'l-1') });
    assert.equal(raced.status, 409);
  } finally {
    await close();
  }
});

test('GET /ready reports 503 until every check passes, then 200', async () => {
  let ready = false;
  const { port, close } = await startWorker({ readinessChecks: async () => ({ authentication: Boolean(TOKEN), ffmpeg: ready }) });
  try {
    const degraded = await call(port, { path: '/ready' });
    assert.equal(degraded.status, 503);
    assert.equal(degraded.json.status, 'not_ready');
    assert.deepEqual(degraded.json.checks, { authentication: true, ffmpeg: false });
    ready = true;
    const live = await call(port, { path: '/ready' });
    assert.equal(live.status, 200);
    assert.equal(live.json.status, 'ready');
  } finally {
    await close();
  }
});

test('an unknown route is 404 and a run failure still replies exactly once', async () => {
  const { port, close } = await startWorker({
    startRun: () => ({ run: Promise.reject(new Error('boom')), abort: () => {} }),
  });
  try {
    assert.equal((await call(port, { path: '/nope' })).status, 404);
    const response = await call(port, { method: 'POST', path: '/work', headers: { authorization: `Bearer ${TOKEN}` }, payload: body('u3', 'l3') });
    assert.equal(response.status, 202);
  } finally {
    await close();
  }
});
