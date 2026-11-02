# Releasing

This document describes how a release of the packages in this repository is
prepared. It deliberately separates two things that are easy to confuse:

- **A repository release** — a Git tag and a GitHub Release describing the
  repository state. This is what `v0.1.0` means here.
- **npm publishing** — putting `@ai-agent/media-worker`, `@ai-agent/medkit` and
  `@ai-agent/transcript-utils` on the npm registry. **The packages are not on
  npm.** Publishing is a separate decision that requires owning the `@ai-agent`
  scope; nothing in this document performs it.

## Versioning

- All packages share one version and move together. A tag names the repository
  state, not an individual package.
- [Semantic Versioning](https://semver.org/) applies. While the major version is
  `0`, a minor bump may contain breaking changes; the public API is not stable
  until `1.0.0`.
- The version lives in four places and must agree: root `package.json` and the
  three package manifests.

## Pre-release checklist

Run from the repository root, on a clean tree:

```bash
npm ci
npm run build
npm test
npm run lint
git diff --check
```

Then confirm:

- [ ] CI is green on `main` for Node.js 20.11, 22 and 24.
- [ ] The FFmpeg integration tests ran (CI job `test (24)` uses the runner's
      `ffmpeg`). If they were skipped locally, say so rather than implying they
      passed.
- [ ] No `dist/`, `node_modules/` or environment file is tracked:
      `git status --porcelain` is empty and `npm run lint` passes.
- [ ] Version numbers agree across the four manifests.

## Changelog

Update `CHANGELOG.md` **before** tagging. Follow
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/):

1. Move `[Unreleased]` content (if any) into a new version heading.
2. Use `## [x.y.z] - YYYY-MM-DD`.
3. Group entries under `Added`, `Changed`, `Fixed`, `Removed`.
4. Describe what a consumer of the packages would notice, and state plainly when
   something is a limitation rather than a feature.

Do not rewrite entries for versions that already exist in public history; add a
new entry instead.

## Tagging

```bash
git switch main
git pull --ff-only
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0          # the tag only
```

Annotated tags (`-a`) are required so the release has an author and message.
Do not move or delete a published tag; release a new patch version instead.

## GitHub Release

```bash
gh release create v0.1.0 --title "v0.1.0" --notes-file <(sed -n '/## \[0.1.0\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

The release notes are the CHANGELOG section for that version, verbatim. Do not
add adoption or usage claims that are not evidenced.

## Publishing to npm (separate, not done here)

Only after the tag exists **and** the `@ai-agent` scope has been verified as
owned by this project:

```bash
for pkg in media-worker medkit transcript-utils; do
  (cd "packages/$pkg" && npm publish --access public)
done
```

`medkit` and `transcript-utils` build through `prepublishOnly`; `media-worker`
ships `src` directly. If publishing ever happens, update the three package
READMEs to replace the "not published to npm" banner with the real install
command in the same change.

## What a release does not mean

A tag does not imply users, adoption, or npm availability. Keep `README.md` and
the package READMEs accurate about what is and is not published.
