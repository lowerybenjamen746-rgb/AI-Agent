# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for a security problem.

Report it privately through GitHub's "Report a vulnerability" tab on the
repository (Security → Advisories → Report a vulnerability). If that is
unavailable, open a minimal issue asking for a private contact channel and
include no details.

Please include: affected package and version, a reproduction, the impact you
believe it has, and whether the worker was reachable from an untrusted network.

## What this project treats as security-relevant

- Authentication bypass on `POST /work` (missing, empty, or timing-leaky token
  comparison).
- A delivery producing more than one HTTP reply, or a post-acceptance failure
  becoming a `4xx`/`5xx`.
- A duplicate delivery starting a second run for the same lease.
- Binding to a non-loopback interface without explicit configuration.
- Path traversal out of a render workspace in `medkit`.
- Command injection through FFmpeg arguments (paths must never be shell-joined).
- Any secret material committed to the repository or written to logs.

## Supported versions

The project is pre-1.0. Security fixes are issued on `main` only, as patch
releases.

## Deployment guidance

- Always set `MEDIA_WORKER_TOKEN` to a high-entropy random value and terminate
  TLS in front of the worker; the worker speaks plain HTTP and expects to be
  reached over a local tunnel.
- Keep `MEDIA_WORKER_HOST` unset (loopback) unless a platform assigns a
  published port.
- Do not run the worker as root, and keep its temp directory on a dedicated
  filesystem or quota.
