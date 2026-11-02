# Testing

Every package is tested with the Node.js built-in test runner — no test
framework dependency.

```bash
cd packages/transcript-utils && npm test      # build + unit tests
cd packages/medkit        && npm test          # build + unit + FFmpeg integration
cd packages/media-worker  && npm test          # HTTP, handshake, startup, cleanup
```

Tested on Node.js 20.11–24.x via CI. Locally verified on Node.js 24.21.0.

## FFmpeg integration tests

`medkit`'s integration tests (real encode, invalid-args exit code, timeout kill,
abort, workspace file API) are skipped when no FFmpeg binary is found, and run
when one is:

```bash
FFMPEG_PATH=/usr/bin/ffmpeg npm test
```

Skipped integration tests mean the *unit* behaviour passed but the binary was
not exercised. A release is only "FFmpeg-verified" when that variable pointed at
a working build.

## What is intentionally not tested here

There is no database, queue, or network service in these packages, so their
tests use in-memory fakes. Anything that contacts a real service belongs in
your application's test suite, not here.
