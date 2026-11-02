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
# from the repository root
npm ci
npm run build            # compiles medkit + transcript-utils to dist/
npm run typecheck        # tsc --noEmit per package; emits no files
npm test                 # three package suites + example smoke tests
npm run lint

# per package
cd packages/media-worker && npm test
cd packages/medkit && npm test           # add FFMPEG_PATH=… to run integration tests
cd packages/transcript-utils && npm test
```

Requirements: Node.js 20.11+. No build is needed for `media-worker`; the other
two build with `npm run build`.

`npm run build` and `npm run typecheck` are different commands on purpose:

| Command | Runs | Writes files |
|---|---|---|
| `npm run build` | `tsc -p tsconfig.json` per package | **yes** — `dist/` |
| `npm run typecheck` | `tsc -p tsconfig.json --noEmit` per package | no |

The examples import from `dist/`, so `npm run build` must run before
`npm test`; `npm run typecheck` alone is enough to check types in an editor or
CI job that does not need the output.

## Node.js 20 compatibility

The minimum supported version is Node.js **20.11**, and it behaves differently
from 22 and 24 in one way that is easy to trip over:

```bash
# Correct on every version — the SHELL expands the glob
node --test test/*.test.mjs

# Broken on 20.11 — quotes stop shell expansion, so the runner gets the literal
# string "test/*.test.mjs" and exits with "Could not find ..."
node --test "test/*.test.mjs"
```

Node 20.11's `--test` accepts file paths, not glob patterns. So:

- **Never quote a test glob** in `package.json` scripts, workflows, or docs.
- Use shell-expanded paths everywhere. A bare directory argument
  (`node --test test/`) is *not* portable: it works on 20.11 but fails on 22/24,
  so the scripts here never rely on it.
- This exact mistake has broken CI twice in this repository's history; both
  fixes are recorded in `CHANGELOG.md`.

If you change a `test` script, run the suite on the minimum version too:

```bash
# with a Node 20.11 install (e.g. nvm, fnm, or a downloaded tarball)
/path/to/node-20.11/bin/node --test test/*.test.mjs
```

## GitHub Actions must be pinned

Workflow actions are pinned to a full commit SHA, not a version tag:

```yaml
# correct — cannot be repointed upstream
- uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262
# rejected by `npm run lint`
- uses: actions/checkout@v4
```

`npm run lint` enforces this. Keep the `# Version: …` comment from the current
entry so the pinned SHA stays human-readable, and update both together when
bumping an action.

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
