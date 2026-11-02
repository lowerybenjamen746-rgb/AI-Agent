#!/usr/bin/env node
// `prepack` guard: a TypeScript package must never be packed or published
// without its build output. `prepublishOnly` only runs for `npm publish`, so a
// bare `npm pack` (local testing, CI artifacts, third-party tooling) would
// silently produce a tarball whose `main` does not exist.
//
// npm runs lifecycle scripts with the package directory as the working
// directory, so the package being packed is `process.cwd()` — not this script's
// own location (this file lives in the repository-root scripts/ directory).
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const packageDirectory = process.cwd();
const entry = join(packageDirectory, 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error(`Refusing to pack ${packageDirectory}: dist/index.js is missing.`);
  console.error('Run `npm run build` (or `npm ci && npm run build` from the repository root) first.');
  process.exit(1);
}
