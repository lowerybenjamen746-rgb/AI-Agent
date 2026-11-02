// Reference coordinator adapter.
//
// This file shows the smallest complete adapter: it satisfies every hook
// `createWorker` requires and does real work only in the sense of validating a
// request against an in-memory lease registry. It intentionally contains no
// database, no queue and no media library — that is the host application's job.
//
// Replace the two exported factories (or pass your own objects to
// `createWorker`) to connect a durable lease store and a real runner.
import { createWorker } from './server.mjs';

/**
 * Minimal request validator.
 *
 * Contract it must uphold: throw (or reject) to reject the delivery with 400,
 * and return `{ request, store }` to accept it. `request.unit.id` and
 * `request.unit.lease.leaseToken` are read by the handshake, so an accepted
 * value must carry both.
 */
export function createMemoryValidator() {
  const leases = new Map();
  return {
    register({ id, leaseToken }) {
      leases.set(id, leaseToken);
    },
    async validateRequest({ text, contractHeader }) {
      const body = JSON.parse(text);
      const unit = body?.unit;
      if (!unit || typeof unit.id !== 'string' || typeof unit.lease?.leaseToken !== 'string') {
        throw new Error('Request is missing unit.id or unit.lease.leaseToken');
      }
      const expected = leases.get(unit.id);
      if (expected !== undefined && expected !== unit.lease.leaseToken) {
        throw new Error('Request does not match the current lease for this unit');
      }
      return { request: { ...body }, store: { contractHeader } };
    },
  };
}

/** Placeholder runner: resolves after a moment and records nothing. */
export function createNoopRunner({ onRun } = {}) {
  return function startRun({ request }) {
    const controller = new AbortController();
    const run = Promise.resolve().then(() => onRun?.({ request, signal: controller.signal }));
    return { run, abort: (reason) => controller.abort(reason) };
  };
}

export function createExampleWorker({ env = process.env } = {}) {
  const validator = createMemoryValidator();
  return createWorker({
    env,
    validateRequest: validator.validateRequest,
    startRun: createNoopRunner(),
    readinessChecks: async () => ({ authentication: Boolean(env.MEDIA_WORKER_TOKEN) }),
    autoStart: env.MEDIA_WORKER_NO_LISTEN !== '1' || env.NODE_ENV !== 'test',
  });
}

if (import.meta.url === `file://${process.argv[1]}`) createExampleWorker();
