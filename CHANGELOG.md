# Changelog

All notable changes to this repository are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-02

First public extraction. Independent packages, no private dependencies.

### Added — `@ai-agent/media-worker` (GPL-3.0-or-later)

- `createWorker()` with adapter-driven validation, execution, readiness and
  logging; `/health`, `/ready`, `/work` contract.
- One-reply handshake with validation before acceptance, idempotent duplicate
  deliveries, `409` for a competing lease.
- Constant-time bearer authentication where an unset token is never valid.
- Endpoint resolution (`SERVER_PORT` → `MEDIA_WORKER_PORT` → `PORT` → `8787`)
  that refuses unusable values instead of silently rebinding.
- Bounded temp reaper with an explicit, configurable prefix list.
- Graceful shutdown that always settles, plus `closeServer({ graceMs })`.
- Read-only host metrics probe.

### Added — `@ai-agent/medkit` (GPL-3.0-or-later)

- FFmpeg discovery with capability proof; an incapable build is refused and
  never swapped for another one.
- Staging for binaries shipped without an execute bit in read-only bundles.
- Bounded execution with real progress and single-settle cancellation.
- MP4 container probe with no decoding; unreadable fields stay `null`.
- Aspect crop/scale filter builder.

### Added — `@ai-agent/transcript-utils` (MIT)

- Chunk-local to absolute timestamp mapping applied exactly once.
- Segment selection and word-timeline repair; malformed transcripts rejected.
- SRT cue generation, timestamp formatting/parsing and proportional re-timing.

### Fixed during extraction

- A chunked (`Transfer-Encoding: chunked`) request body is now read correctly.
- A pending run can no longer hold the server open forever on shutdown.

### Fixed after the first publication (CI)

- Test scripts no longer quote the test glob: Node.js 20.11 does not expand a
  quoted glob for `--test`, so the runner received a literal path and failed
  before running a test. Shell expansion works on 20.11, 22 and 24.
- The CI secret scan assembles its pattern from fragments and skips the scanner
  files, so the workflow no longer fails on its own source while still
  detecting a synthetic token.
- CI steps invoke the package `npm test` scripts instead of their own quoted
  glob, so the workflow and the documented command cannot diverge again.

### Changed after the first publication (docs)

- The package READMEs state that the packages are **not published to npm** and
  document source installation instead of an install command that returns 404.
- `medkit` resolves its text-render assets relative to the installed module
  instead of `process.cwd()`; an explicit `stageTextAssets({ cwd })` override is
  still honoured and now validated before a cached result is reused.
- Documented operational limits: 256 KiB request cap, HTTP-only transport,
  `TMPDIR` location, 24-hour default temp retention and the in-memory reference
  adapter's restart behaviour.

### Known limitations

- `transcript-utils` has no built-in provider clients; it operates on data.
- The worker is HTTP-only by design; terminate TLS in front of it.
- No FFmpeg binary is distributed; you supply the build and its licence
  obligations.
- The packages are not on npm. The `@ai-agent` scope has not been verified as
  owned by this project.
