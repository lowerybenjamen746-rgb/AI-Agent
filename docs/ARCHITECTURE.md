# Architecture

Three packages, no shared runtime code. Each can be installed and used alone.

```
                        ┌──────────────────────────────┐
   coordinator ── HTTP──▶│  packages/media-worker       │
   (your app)            │  server.mjs                  │
                         │   ├─ startup-endpoint.mjs    │  bind resolution
                         │   ├─ work-handshake.mjs      │  validation → 202, one reply
                         │   ├─ temp-cleanup.mjs        │  stale-workdir reaper
                         │   └─ adapters (you supply)   │  validate / run / readiness
                         └───────────┬──────────────────┘
                                     │ injects
                                     ▼
                         ┌──────────────────────────────┐
                         │  packages/medkit             │
                         │  ffmpeg-runner.ts            │  discovery, staging, exec
                         │  video-probe.ts              │  MP4 box walk (no decode)
                         │  aspect-crop.ts             │  crop/scale filter builder
                         └──────────────────────────────┘

                         ┌──────────────────────────────┐
      ASR output ───────▶│  packages/transcript-utils   │──▶ SRT / cues
                         │  timestamps → selected-words │
                         │  → word-timeline → srt       │
                         └──────────────────────────────┘
```

## media-worker

The server owns process concerns only. Everything coordinator-specific is an
adapter:

| Adapter | Contract |
|---|---|
| `getToken()` | Bearer token the worker accepts. Unset is never valid. |
| `validateRequest({ text, contractHeader })` | Throw to reject (400); return `{ request, store }` to accept. `request.unit.id` and `request.unit.lease.leaseToken` are required by the handshake. |
| `startRun({ request, store })` | Return `{ run, abort }`. `run` is awaited; `abort` is called on shutdown. |
| `readinessChecks()` | Map of named booleans; all must be true for `/ready` 200. |

Ordering is the whole design: a delivery is validated **before** the 202 is
written, and after acceptance no error can produce a second HTTP reply —
the durable lease, not the response, is the authority on the outcome.

## medkit

`detectFFmpeg()` walks candidates in a fixed order (`FFMPEG_PATH` is
authoritative and ends the search; then a bundled `ffmpeg-static`, `PATH`, and
known install locations). The first candidate that is a real FFmpeg build
decides the outcome: if it lacks a required filter or encoder the result is
`available: false` naming the gap. There is no fallback to a different build.

If a pipeline's declared requirement is narrower or wider than the defaults,
pass `requiredFilters` / `requiredEncoders`. `runFFmpeg()` bounds wall time,
parses progress from FFmpeg's own `time=` output only once the input duration
is known, and settles exactly once on `close`.

`probeVideoContainer()` reads an MP4's box structure (`moov`/`trak`/`mdhd`/
sample tables) from a buffer already in memory. It decodes nothing; anything it
cannot read is `null`, never `0`.

## transcript-utils

`absoluteSegment()` adds a chunk's source offset exactly once, so the canonical
transcript holds absolute source seconds that survive chunk reordering and
provider fallback. `selectTranscriptSegments()` clamps the overlap with a
window and rejects malformed timings. `clipSegmentsToRange()` converts absolute
segments to clip-relative cues, and `scaleSrtTimestamps()` re-times an existing
SRT when a duration-changing pass ran between cue generation and burn-in.
