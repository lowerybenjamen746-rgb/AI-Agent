# Contributing

Thanks for considering a contribution.

## Before you start

- Open an issue describing the problem or proposal. Behaviour changes to the
  worker contract (`202`/`400`/`401`/`409`, one-reply rule) or to a public
  signature need agreement before code.
- Keep packages independent. A package must not import from another package in
  this repository at runtime; duplication of a tiny helper is preferred to a
  cross-package dependency.

## Development

```bash
# per package
cd packages/media-worker && npm test
cd packages/medkit && npm test           # add FFMPEG_PATH=… to run integration tests
cd packages/transcript-utils && npm test
```

Requirements: Node.js 20.11+. No build is needed for `media-worker`; the other
two build with `npm run build`.

## Rules

1. **Do not weaken a guarantee to make a test pass.** The handshake ordering,
   the single-reply rule, loopback-by-default binding and constant-time token
   comparison are contract, not implementation detail.
2. **Add a regression test** for every bug fix. If the bug was "a state is
   accepted that should be refused", the test asserts the refusal.
3. **Never claim a check passed that did not run.** A skipped FFmpeg test is a
   skip, not a pass.
4. **No secrets, ever** — not in code, tests, fixtures, examples or CI. Use
   placeholder strings that obviously are not credentials.
5. Match the existing code style: TypeScript strict, `.mjs` for the worker,
   no new runtime dependencies without discussion.
6. Keep commit messages in Conventional Commits form (`fix:`, `feat:`,
   `docs:`, `test:`, `chore:`).

## Licensing of contributions

By contributing you agree your contribution is licensed under the license of
the package you changed (GPL-3.0-or-later for `media-worker` and `medkit`, MIT
for `transcript-utils`).

## Pull requests

Include: what changed, why, how it was verified (exact commands and results),
and any behaviour a reviewer should be suspicious of. CI must be green.
