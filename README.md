# AI-AGENT

Reusable infrastructure for running media jobs on a Node host.

This repository contains three small, independently usable packages extracted
from a private media-automation application and generalised so they do not
depend on it:

| Package | What it does | License |
|---|---|---|
| [`packages/media-worker`](packages/media-worker) | Lease-fenced HTTP worker: authentication, `/health`, `/ready`, `/work`, temp reaping, graceful shutdown — with your coordinator plugged in as adapters | GPL-3.0-or-later |
| [`packages/medkit`](packages/medkit) | Native FFmpeg execution backend: binary discovery and capability proof, read-only-bundle staging, bounded runs with progress, cancellation, plus a pure MP4/WebM container probe | GPL-3.0-or-later |
| [`packages/transcript-utils`](packages/transcript-utils) | Provider-agnostic transcript timing: absolute-timestamp mapping, word-timeline repair, segment selection, SRT generation and re-timing | MIT |

## Why these three

A render worker looks simple until it has to answer the questions that decide
whether a queue is trustworthy:

- **Who owns the unit?** The worker accepts a delivery only after its lease is
  validated, answers exactly once, and never turns a post-acceptance failure
  into a second reply. A duplicate delivery of the same lease is idempotent; a
  different lease is refused.
- **Is the host actually able to do the work?** `medkit` proves the FFmpeg
  build can run the chain you need *before* a job starts, rather than failing
  mid-encode. It never silently substitutes a different binary.
- **Are timings honest?** `transcript-utils` keeps measured timings verbatim,
  marks derived ones as `estimated`, and refuses malformed transcripts instead
  of emitting subtitles that drift.

## Install and run

Requires Node.js 20.11 or newer.

```bash
git clone https://github.com/lowerybenjamen746-rgb/AI-AGENT.git
cd AI-AGENT/packages/media-worker
npm test
MEDIA_WORKER_TOKEN="$(openssl rand -hex 32)" npm start
```

Then:

```bash
curl -s localhost:8787/health   # {"status":"ok","contract":"media-worker-v1"}
curl -s localhost:8787/ready    # 200 when the adapter's checks pass, 503 otherwise
```

The example adapter accepts any well-formed `{ "unit": { "id", "lease": { "leaseToken" } } }`
payload against an in-memory registry. Replace it with your own — see
[docs/WORKER.md](docs/WORKER.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Worker guide](docs/WORKER.md)
- [Testing](docs/TESTING.md)
- [Licensing](docs/LICENSING.md)
- [Releasing](docs/RELEASING.md)
- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) · [Code of conduct](CODE_OF_CONDUCT.md)

## Status

Pre-1.0 (`0.1.0`). The packages are functional and tested; the public API may
change between minor versions until `1.0.0`. No production users are claimed.

## License

This repository is mixed-licensed; see [docs/LICENSING.md](docs/LICENSING.md)
for the per-package map and the FFmpeg obligations that motivate it.
