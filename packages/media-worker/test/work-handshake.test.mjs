import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCEPTED_REPLY,
  MAX_REQUEST_BYTES,
  REJECTED_REPLY,
  readBoundedBody,
  readDeliverableBody,
  runWorkHandshake,
  sendWorkReply,
  shutdownActiveRuns,
} from '../src/work-handshake.mjs';

function fakeRequest(chunks) {
  return (async function* stream() {
    for (const chunk of chunks) yield Buffer.from(chunk);
  })();
}

function fakeResponse() {
  const state = { status: null, headers: null, body: '', ended: false, writableEnded: false, destroyed: false };
  return {
    state,
    writeHead(status, headers) {
      if (state.writableEnded) throw new Error('ERR_HTTP_HEADERS_SENT');
      state.status = status;
      state.headers = headers;
    },
    end(body) {
      if (state.writableEnded) throw new Error('ERR_HTTP_HEADERS_SENT');
      state.body = body;
      state.ended = true;
      state.writableEnded = true;
    },
  };
}

test('a body over the limit is rejected instead of truncated', async () => {
  await assert.rejects(() => readBoundedBody(fakeRequest(['x'.repeat(8), 'y'.repeat(8)]), 10), /exceeds 10 bytes/);
  assert.equal(await readBoundedBody(fakeRequest(['ok']), 10), 'ok');
  assert.deepEqual(await readDeliverableBody(fakeRequest(['x'.repeat(32)]), 4), { text: null });
});

test('the default limit is the documented one', () => {
  assert.equal(MAX_REQUEST_BYTES, 256 * 1024);
  assert.equal(ACCEPTED_REPLY.status, 202);
  assert.equal(REJECTED_REPLY.status, 400);
});

test('sendWorkReply writes at most once and never throws after the response is gone', () => {
  const response = fakeResponse();
  assert.equal(sendWorkReply(response, 200, { ok: true }), true);
  assert.equal(sendWorkReply(response, 500, { ok: false }), false);
  assert.equal(response.state.status, 200);
  assert.equal(sendWorkReply({ destroyed: true }, 200, {}), false);
  assert.equal(sendWorkReply(null, 200, {}), false);
});

test('an unreadable body yields exactly one 400 reply', async () => {
  const reply = await runWorkHandshake({
    readBody: async () => null,
    validateRequest: async () => { throw new Error('must not run'); },
    startRun: () => { throw new Error('must not run'); },
  });
  assert.equal(reply.status, 400);
});

test('validation runs before acceptance and its failure is a 400', async () => {
  const reply = await runWorkHandshake({
    readBody: async () => JSON.stringify({ unit: { id: 'u', lease: { leaseToken: 'l' } } }),
    validateRequest: async () => { throw new Error('lease mismatch'); },
    startRun: () => { throw new Error('must not run'); },
  });
  assert.equal(reply.status, 400);
});

test('an accepted unit runs once and answers 202; a duplicate delivery of the same lease is idempotent', async () => {
  const activeRuns = new Map();
  let starts = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const handshake = runWorkHandshake({
    readBody: async () => JSON.stringify({ unit: { id: 'unit-1', lease: { leaseToken: 'lease-1' } } }),
    validateRequest: async ({ text }) => ({ request: JSON.parse(text) }),
    startRun: () => {
      starts += 1;
      return { run: gate, abort: () => {} };
    },
    activeRuns,
  });
  while (!activeRuns.has('unit-1')) await new Promise((resolve) => setTimeout(resolve, 5));
  const duplicate = await runWorkHandshake({
    readBody: async () => JSON.stringify({ unit: { id: 'unit-1', lease: { leaseToken: 'lease-1' } } }),
    validateRequest: async () => { throw new Error('must not revalidate'); },
    startRun: () => { throw new Error('must not restart'); },
    activeRuns,
  });
  assert.equal(duplicate.status, 202);
  release();
  const accepted = await handshake;
  assert.equal(accepted.status, 202);
  assert.equal(starts, 1);
  assert.equal(activeRuns.size, 0, 'the active entry is removed when the run settles');
});

test('a different lease for an in-flight unit is refused with 409', async () => {
  const activeRuns = new Map([
    ['unit-2', { leaseToken: 'lease-a', accepted: {} }],
  ]);
  const reply = await runWorkHandshake({
    readBody: async () => JSON.stringify({ unit: { id: 'unit-2', lease: { leaseToken: 'lease-b' } } }),
    validateRequest: async () => { throw new Error('must not run'); },
    startRun: () => { throw new Error('must not run'); },
    activeRuns,
  });
  assert.equal(reply.status, 409);
});

test('a run failure after acceptance never becomes a second reply', async () => {
  const seen = [];
  const reply = await runWorkHandshake({
    readBody: async () => JSON.stringify({ unit: { id: 'unit-3', lease: { leaseToken: 'lease-3' } } }),
    validateRequest: async ({ text }) => ({ request: JSON.parse(text) }),
    startRun: () => ({ run: Promise.reject(new Error('boom')), abort: () => {} }),
    onRunError: async (context) => seen.push(context),
  });
  assert.equal(reply.status, 202);
  assert.deepEqual(seen, ['media-worker.work.run']);
});

test('shutdown aborts in-flight runs and waits for them to settle', async () => {
  const aborted = [];
  const activeRuns = new Map();
  let settled = 0;
  for (const id of ['a', 'b']) {
    activeRuns.set(id, {
      abort: (reason) => aborted.push(reason.message),
      run: new Promise((resolve) => setTimeout(() => { settled += 1; resolve(); }, 10)),
    });
  }
  await shutdownActiveRuns(activeRuns, { reason: 'SIGTERM' });
  assert.deepEqual(aborted, ['SIGTERM', 'SIGTERM']);
  assert.equal(settled, 2);
});
