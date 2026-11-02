# AI-AGENT

Reusable infrastructure for running media jobs on a Node.js host.

Three independent packages, each usable on its own. They were extracted from a
private media-automation application and generalised so nothing here depends on
it. There is no shared runtime code between them.

## The three packages

| Package | Purpose | Main dependency | License |
|---|---|---|---|
| [`media-worker`](packages/media-worker) | Lease-fenced HTTP worker: auth, `/health`, `/ready`, `/work`, temp reaping, graceful shutdown | Node.js built-ins only | GPL-3.0-or-later |
| [`medkit`](packages/medkit) | FFmpeg execution backend, MP4 metadata probe, aspect-crop helper | FFmpeg (you supply it) | GPL-3.0-or-later |
| [`transcript-utils`](packages/transcript-utils) | Absolute timestamps, word timelines, segment selection, SRT generation | Node.js built-ins only | MIT |

Dependency and licence columns are taken from the package manifests and
`docs/LICENSING.md`. The split follows the dependency graph: anything that drives
FFmpeg is GPL, the pure data utilities are MIT.

## Is this for you?

| You want to… | Start with |
|---|---|
| Accept jobs over HTTP and run them exactly once per lease | `media-worker` |
| Find FFmpeg, prove it can run your chain, then run it | `medkit` |
| Turn ASR timings into correct, clip-relative subtitles | `transcript-utils` |
| Do all three in one service | All three — they compose, but none imports another |

## Requirements

- **Node.js 20.11 or newer** (tested on 20.11, 22 and 24).
- **FFmpeg** for `medkit` only — this repository does not ship a binary.
  Point `FFMPEG_PATH` at a build, or put `ffmpeg` on `PATH`.
- No database, queue or network service is required to run the examples.

## Clone and install

```bash
git clone https://github.com/lowerybenjamen746-rgb/AI-AGENT.git
cd AI-AGENT
npm ci          # workspace install: TypeScript only
npm run build   # compiles medkit and transcript-utils to dist/
```

`media-worker` ships plain JavaScript and needs no build step.

**The packages are not published to npm.** `npm install @ai-agent/…` does not
work yet. Install from this repository by path:

```bash
npm install /path/to/AI-AGENT/packages/medkit
```

## Build and test

```bash
npm run build            # TypeScript → dist/ (required before the examples run)
npm run typecheck        # tsc --noEmit; checks types, writes nothing
npm test                 # 3 package suites + example smoke tests
npm run test:examples    # example smoke tests only
npm run lint             # license, secret, artifact and env-file checks

# FFmpeg integration tests run only when a binary is available:
FFMPEG_PATH=/usr/bin/ffmpeg npm test
```

## Run the examples

```bash
node examples/01-media-worker/run.mjs
FFMPEG_PATH=/usr/bin/ffmpeg node examples/02-medkit/run.mjs
node examples/03-transcript-utils/run.mjs
```

Each prints what it actually observed. Details: [examples/README.md](examples/README.md).

### Minimal worker usage

```bash
cd packages/media-worker
MEDIA_WORKER_TOKEN="$(openssl rand -hex 32)" npm start
curl -s localhost:8787/health   # {"status":"ok","contract":"media-worker-v1"}
```

The bundled entry point uses an in-memory reference adapter. For real work,
call `createWorker()` with your own `validateRequest` / `startRun` — see
[docs/WORKER.md](docs/WORKER.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — package boundaries and data flow
- [Worker guide](docs/WORKER.md) — endpoints, configuration, operational limits
- [Testing](docs/TESTING.md)
- [Licensing](docs/LICENSING.md) — why GPL for some packages
- [Releasing](docs/RELEASING.md)
- [External testing](docs/EXTERNAL-TESTING.md) — how to try the packages independently

## Project status and limitations

- Version `0.1.0`, pre-`1.0.0`: the public API may change between minor versions.
- **No external users, contributors or adoption are claimed.** The project is
  newly published.
- The packages are not on npm, and the `@ai-agent` scope has not been verified
  as owned by this project.
- `media-worker` speaks HTTP only; terminate TLS in front of it.
- `medkit` never downloads an FFmpeg binary for you, and refuses to substitute a
  different build than the one you configured.
- `transcript-utils` has no ASR provider clients; it operates on data you supply.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: open an issue first for
behaviour changes, keep the packages independent, add a regression test for every
fix, and never commit a secret. Report vulnerabilities via [SECURITY.md](SECURITY.md).

The repository includes a [code of conduct](CODE_OF_CONDUCT.md).

## License

Mixed licensing — see [docs/LICENSING.md](docs/LICENSING.md):

- `packages/media-worker`, `packages/medkit` — **GPL-3.0-or-later**
- `packages/transcript-utils` — **MIT**
