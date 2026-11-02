# Examples

Three runnable examples, one per package. Each uses only the package's real
exported API and prints what it actually observed — none of the output is
hard-coded.

Run them from the repository root after `npm ci`:

```bash
npm run build                              # medkit + transcript-utils

node examples/01-media-worker/run.mjs      # no build or deps needed
FFMPEG_PATH=/usr/bin/ffmpeg node examples/02-medkit/run.mjs
node examples/03-transcript-utils/run.mjs
```

`examples/02-medkit` runs without FFmpeg too: it prints how to fix detection and
which checks were skipped, exiting 0.

If `dist/` is missing, examples 2 and 3 exit **2** and print the prerequisite
(`npm ci && npm run build`) rather than failing with a module-resolution error.
The smoke tests assert that behaviour, so a broken build can't pass CI silently.

## 1. `01-media-worker` — HTTP worker end to end

Starts the worker on an ephemeral port with a small coordinator adapter, then
exercises:

- `GET /health` and `GET /ready`, including what readiness reports
- authentication: no token → `401`, wrong token → `401`
- validation: malformed JSON → `400`, stale lease → `400`
- an accepted delivery → `202`
- an unknown route → `404`
- graceful shutdown, after which the port refuses connections

The adapter callbacks (`getToken`, `validateRequest`, `startRun`,
`readinessChecks`) are the only coordinator-specific code; a real service swaps
the in-memory lease map for its own store.

## 2. `02-medkit` — FFmpeg detection, encode, probe

- Detects FFmpeg and prints the source and version, or the reason it is unusable
- Shows that a missing required filter is reported by name
- Encodes a 2-second MP4 with the real FFmpeg binary
- Probes that file and prints container, dimensions and duration
- Probes a missing file (`null`) and a non-video file (unknown container)
- Shows invalid FFmpeg arguments produce a non-zero exit, not a crash
- Resolves the bundled text assets from the installed module
- Builds a `9:16` crop filter

## 3. `03-transcript-utils` — timings to subtitles

- Maps provider-local times onto absolute source seconds
- Validates a transcript
- Selects the segments inside a clip window (and none outside it)
- Generates clip-relative SRT
- Re-times that SRT for a 1.25× speed change
- Produces a `Blob`, or `null` when there are no cues
- Rejects malformed timings, disordered words and a zero scale factor

## Smoke tests

`examples/test/examples.test.mjs` runs all three as subprocesses and asserts on
their output, so a broken example fails the suite rather than becoming wrong
documentation.

```bash
npm run test:examples   # or: node --test examples/test/*.test.mjs
```
