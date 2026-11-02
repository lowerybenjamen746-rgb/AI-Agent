// Media worker `/work` handshake — validation, acceptance, and run ownership.
//
// The handshake is two-phase on purpose. Everything that can reject a request
// runs BEFORE the 202 is written; once the worker has accepted the lease it owns
// the unit, so no later error may turn the same HTTP call into a 400 (the
// coordinator would read that as a protocol failure while the unit is running)
// or write a second response.
//
// This module owns only that ordering and the per-unit run registry. The
// request/lease/source checks and the executor are injected, so the contract is
// executable in an offline test without a database, a lease or FFmpeg.

/** Largest request body the worker accepts. */
export const MAX_REQUEST_BYTES = 256 * 1024;

export const ACCEPTED_REPLY = Object.freeze({ status: 202 });
export const REJECTED_REPLY = Object.freeze({ status: 400, body: { error: 'Invalid worker request' } });
const ZERO_RECEIPT = Object.freeze({ requests: 0, bytesRead: 0, bytesWritten: 0, diskBytes: 0, memoryBytes: 0, ffmpegMs: 0 });

export class DuplicateInFlightError extends Error {
  constructor(unitId, leaseToken) {
    super(`Media work unit ${unitId} is already in flight under lease ${leaseToken}`);
    this.name = 'DuplicateInFlightError';
  }
}

/**
 * Read and bound the request body. A body over the limit is a rejection, never
 * a silently truncated unit reference.
 *
 * Pass a chunk-decoded stream (`IncomingMessage` itself works: for-await on it
 * decodes transfer framing). A non-iterable input is reported as unreadable.
 */
export async function readBoundedBody(request, limit = MAX_REQUEST_BYTES) {
  if (!request || typeof request[Symbol.asyncIterator] !== 'function') {
    throw new Error('Media worker request body is not readable');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error(`Media worker request exceeds ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The server-side read: never throws. An unreadable, oversized or empty body is
 * reported as `{ text: null }` so the handshake answers one 400 for it.
 */
export async function readDeliverableBody(request, limit = MAX_REQUEST_BYTES) {
  try {
    return { text: await readBoundedBody(request, limit) };
  } catch {
    return { text: null };
  }
}

function duplicateLeaseFor(rawText) {
  let unitId = null;
  let leaseToken = null;
  try {
    const parsed = JSON.parse(rawText);
    unitId = parsed?.unit?.id ?? null;
    leaseToken = parsed?.unit?.lease?.leaseToken ?? null;
  } catch {}
  return { unitId, leaseToken };
}

/**
 * The single reply site for `/work`.
 *
 * The handshake resolves after an `await` on the run, so by the time a reply is
 * written the client may have disconnected, the socket may be destroyed, or a
 * second delivery may already have answered on the same response. Writing then
 * throws (`ERR_HTTP_HEADERS_SENT`, `ERR_STREAM_DESTROYED`) out of an async
 * request handler, where nothing can observe it. This helper writes at most once
 * and reports whether it wrote; the durable lease — not the HTTP reply — is the
 * authority on the unit's outcome.
 *
 * @returns {boolean} true only when this call wrote the reply
 */
export function sendWorkReply(response, status, body, extraHeaders = {}) {
  if (!response || response.writableEnded || response.destroyed) return false;
  try {
    response.writeHead(status, { 'content-type': 'application/json', ...extraHeaders });
    response.end(JSON.stringify(body));
    return true;
  } catch {
    return false;
  }
}

/**
 * Run one `/work` delivery to completion.
 *
 * Resolves with the ONLY reply the coordinator may receive:
 *   { status: 202, body }                          accepted, or an idempotent repeat
 *   { status: 400, body }                          rejected during validation
 *   { status: 409, body }                          a different lease holds this unit
 *
 * The run is awaited before returning, but its failure can never produce a
 * second reply: it is logged through `onRunError` and the unit stays fenced by
 * its durable lease, which is what a coordinator retry has to re-check.
 *
 * @param {object} input
 * @param {() => Promise<string | null>} input.readBody  null = unreadable body
 * @param {(args: { text: string }) => Promise<object>} input.validateRequest
 * @param {(request: object) => { run: Promise<unknown>, abort: (reason?: unknown) => void }} input.startRun
 * @param {Map<string, object>} [input.activeRuns]
 * @param {(context: string, error: unknown) => Promise<unknown>} [input.onRunError]
 */
export async function runWorkHandshake({
  readBody,
  validateRequest,
  startRun,
  activeRuns = new Map(),
  onRunError = async () => {},
}) {
  let text;
  let request;
  let store = null;
  try {
    text = await readBody();
  } catch (error) {
    await onRunError('media-worker.work', error);
    return REJECTED_REPLY;
  }

  if (typeof text !== 'string') {
    await onRunError('media-worker.work', new Error('Media worker request body could not be read'));
    return REJECTED_REPLY;
  }

  const { unitId, leaseToken } = duplicateLeaseFor(text);
  if (unitId !== null) {
    const active = activeRuns.get(unitId);
    if (active) {
      if (active.leaseToken === leaseToken) {
        return { status: 202, body: { ...active.accepted, unitId, leaseToken, outcome: 'accepted', resourceReceipt: ZERO_RECEIPT, externalSideEffects: [] } };
      }
      return { status: 409, body: { error: 'Work unit is already running under another lease' } };
    }
  }

  try {
    const validation = await validateRequest({ text, unitId, leaseToken });
    // A second delivery can finish validation while the first is still in its
    // awaits: the validator reports the race instead of returning a request.
    if (validation?.duplicate) {
      return { status: 409, body: { error: 'Work unit is already running under another lease' } };
    }
    request = validation.request ?? validation;
    store = validation.store ?? null;
  } catch (error) {
    await onRunError('media-worker.work', error);
    return REJECTED_REPLY;
  }

  const id = request.unit.id;
  const accepted = {
    unitId: id,
    leaseToken: request.unit.lease.leaseToken,
    outcome: 'accepted',
    resourceReceipt: ZERO_RECEIPT,
    externalSideEffects: [],
  };

  // The unit is ours from here on. Register the run before the handshake is
  // written so a duplicate delivery that overtakes it finds the active entry
  // and receives the idempotent 202 instead of starting a second run.
  const { run, abort } = startRun({ request, store });
  const activeRun = { leaseToken: request.unit.lease.leaseToken, run, abort, accepted };
  activeRuns.set(id, activeRun);
  try {
    await run;
  } catch (error) {
    // Already acknowledged: the durable checkpoint/failure was written by the
    // runner. This must never become a second HTTP response.
    await onRunError('media-worker.work.run', error);
  } finally {
    if (activeRuns.get(id) === activeRun) activeRuns.delete(id);
  }
  return { status: 202, body: accepted };
}

/**
 * Abort every in-flight run and wait for it to settle (process shutdown). The
 * server refuses new deliveries while shutting down, so a delivery cannot start
 * work the process is about to lose.
 */
export async function shutdownActiveRuns(activeRuns, { reason = 'Worker shutdown' } = {}) {
  for (const active of activeRuns.values()) active.abort?.(new Error(reason));
  await Promise.allSettled([...activeRuns.values()].map((active) => active.run));
}
