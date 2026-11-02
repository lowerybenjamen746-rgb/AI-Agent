# Worker guide

`@ai-agent/media-worker` is a dependency-free HTTP worker (Node built-ins only).

## Endpoints

| Endpoint | Auth | Answer |
|---|---|---|
| `GET /health` | none | `200 {"status":"ok","contract":"media-worker-v1"}` |
| `GET /ready` | none | `200` when every readiness check is true, else `503 {"status":"not_ready","checks":{…}}` |
| `POST /work` | `Authorization: Bearer <token>` | `202` accepted / `400` invalid / `401` unauthorized / `409` another lease holds the unit / `500` internal |
| anything else | — | `404` |

Every reply carries `x-media-worker-contract`. A delivery is answered exactly
once: validation happens before the `202`, and a run failure afterwards is
logged, never re-replied.

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| `MEDIA_WORKER_TOKEN` | Bearer token. Unset means every `/work` call is `401`. | unset |
| `SERVER_PORT` | Platform-assigned port (takes precedence). | — |
| `MEDIA_WORKER_PORT` | Explicit port. | — |
| `PORT` | Generic fallback. | — |
| `MEDIA_WORKER_HOST` | Bind address. Loopback unless set, or unless `SERVER_PORT` publishes one. | `127.0.0.1` |
| `MEDIA_WORKER_NO_LISTEN` | `1` disables binding (test mode). | — |

Port precedence is `SERVER_PORT` → `MEDIA_WORKER_PORT` → `PORT` → `8787`. A
value that is set but unusable throws instead of silently binding another port,
because a silent fallback is indistinguishable from success.

## Wiring your own coordinator

```js
import { createWorker } from '@ai-agent/media-worker';

const worker = createWorker({
  getToken: () => process.env.MEDIA_WORKER_TOKEN,
  async validateRequest({ text, contractHeader }) {
    const body = JSON.parse(text);
    const lease = await myStore.getLease(body.unit.id);
    if (!lease || lease.token !== body.unit.lease.leaseToken) throw new Error('lease mismatch');
    return { request: body, store: myStore };
  },
  startRun({ request, store }) {
    const controller = new AbortController();
    const run = myRunner(request, store, controller.signal);
    return { run, abort: (reason) => controller.abort(reason) };
  },
  async readinessChecks() {
    return { authentication: Boolean(process.env.MEDIA_WORKER_TOKEN), ffmpeg: true };
  },
});
```

`createWorker` returns `{ server, start, shutdown, closeServer, endpoint,
activeRuns }`. `shutdown()` refuses new deliveries, aborts in-flight runs and
waits for them; `closeServer({ graceMs })` always settles, destroying remaining
sockets after the grace period.

## Temp directories

`cleanupStaleWorkerTempDirectories({ root, maxAgeMs, prefixes })` removes only
directories matching `prefixes` older than `maxAgeMs` (default 24 h). Pass your
own prefixes; the default `media-worker-*` set matches what this package
documents. An empty list or an empty string is refused, because either would
degenerate into "delete everything in the temp root".

## Metrics

`node src/probe-metrics.mjs [--temp-dir DIR]` prints one JSON object of host
measurements (RAM, CPU, disk, temp usage, pid, node version). Read-only.
