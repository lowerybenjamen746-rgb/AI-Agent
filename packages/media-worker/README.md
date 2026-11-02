# @ai-agent/media-worker

A lease-fenced HTTP media worker you wire to your own coordinator.

Node built-ins only — there are no runtime dependencies.

## Install

> This package is **not published to npm**. `npm install @ai-agent/media-worker`
> does not work yet. Install it from source.

```bash
git clone https://github.com/lowerybenjamen746-rgb/AI-AGENT.git
cd AI-AGENT/packages/media-worker
node src/index.mjs          # no dependency install needed
```

Or add it to another project by path:

```bash
npm install /path/to/AI-AGENT/packages/media-worker
```

## Run

```bash
MEDIA_WORKER_TOKEN="$(openssl rand -hex 32)" node src/index.mjs
curl -s localhost:8787/health
```

The bundled entry point uses the reference adapter in `src/example-adapter.mjs`
(an in-memory lease registry and a no-op runner). For real work, call
`createWorker()` with your own adapters.

## Endpoints

| Endpoint | Auth | Answer |
|---|---|---|
| `GET /health` | none | `200 {"status":"ok","contract"}` |
| `GET /ready` | none | `200` / `503` from your readiness checks |
| `POST /work` | Bearer token | `202` / `400` / `401` / `409` / `500` |

Full contract and configuration: [../../docs/WORKER.md](../../docs/WORKER.md).

## Guarantees

- Validation runs **before** the acceptance reply; the lease is validated
  against your store, not trusted from the request.
- One reply per delivery. A run that fails after acceptance is logged and the
  unit stays fenced by its lease.
- A duplicate delivery under the same lease gets an idempotent `202`; a
  different lease gets `409`.
- Token comparison is constant-time; an unset token is never valid.
- Loopback binding unless explicitly configured.
- Shutdown refuses new deliveries, aborts in-flight runs and always settles.

## Test

```bash
npm test
```

## License

GPL-3.0-or-later. See [../../docs/LICENSING.md](../../docs/LICENSING.md).
