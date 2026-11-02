// Packaging guards: a TypeScript package must not be packable without dist/.
//
// `prepublishOnly` only runs for `npm publish`, so without a `prepack` guard a
// bare `npm pack` produces a tarball whose `main` does not exist. These tests
// run the guard script directly with a chosen working directory, so they never
// touch the real dist/ directories.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const guard = join(root, 'scripts', 'require-dist.mjs');

const runGuard = (cwd) =>
  new Promise((resolve) => {
    execFile(process.execPath, [guard], { cwd }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });

test('the prepack guard refuses a package with no dist', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'pack-no-dist-'));
  try {
    const result = await runGuard(fixture);
    assert.equal(result.code, 1, 'must exit non-zero');
    assert.match(result.stderr, /Refusing to pack/);
    assert.match(result.stderr, /dist\/index\.js is missing/);
    assert.match(result.stderr, /npm run build/, 'must say how to fix it');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('the prepack guard allows a package that has been built', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'pack-with-dist-'));
  try {
    await mkdir(join(fixture, 'dist'), { recursive: true });
    await writeFile(join(fixture, 'dist', 'index.js'), 'export {};\n');
    const result = await runGuard(fixture);
    assert.equal(result.code, 0, 'built package must pass');
    assert.equal(result.stdout, '');
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('both TypeScript packages declare the prepack guard', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const pkg of ['packages/medkit', 'packages/transcript-utils']) {
    const manifest = JSON.parse(await readFile(join(root, pkg, 'package.json'), 'utf8'));
    assert.equal(manifest.scripts.prepack, 'node ../../scripts/require-dist.mjs', `${pkg} must declare prepack`);
    assert.ok(manifest.scripts.prepublishOnly, `${pkg} must still build on publish`);
  }
});
