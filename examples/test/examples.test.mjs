// Smoke tests for the three runnable examples.
//
// These execute each example as a real subprocess and assert on its output, so
// an example that stops working fails CI instead of quietly becoming wrong
// documentation.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The test file lives at examples/test/, so the repository root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(script, { env = process.env, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script], { cwd: root, env, timeout }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

// The built examples are REQUIRED, not optional: skipping them would let a
// broken build pass CI silently. `npm run build` must run first.
const medkitBuilt = existsSync(join(root, 'packages', 'medkit', 'dist', 'index.js'));
const transcriptBuilt = existsSync(join(root, 'packages', 'transcript-utils', 'dist', 'index.js'));

test('built outputs exist (run `npm ci && npm run build` first)', () => {
  assert.ok(medkitBuilt, 'packages/medkit/dist/index.js is missing — run `npm ci && npm run build`');
  assert.ok(transcriptBuilt, 'packages/transcript-utils/dist/index.js is missing — run `npm ci && npm run build`');
});

test('example 1 (media-worker) demonstrates every documented status path', { timeout: 120_000 }, async () => {
  const { code, stdout } = await run(join(root, 'examples', '01-media-worker', 'run.mjs'));
  assert.equal(code, 0, 'example must exit 0');
  assert.match(stdout, /GET \/health\s+\{"status":"ok","contract":"media-worker-v1"\}/);
  assert.match(stdout, /GET \/ready\s+200 /);
  assert.match(stdout, /POST \/work \(no token\)\s+401/);
  assert.match(stdout, /POST \/work \(wrong token\)\s+401/);
  assert.match(stdout, /POST \/work \(malformed\)\s+400/);
  assert.match(stdout, /POST \/work \(stale lease\)\s+400/);
  assert.match(stdout, /POST \/work \(valid\)\s+202 outcome=accepted/);
  assert.match(stdout, /GET \/nope\s+404/);
  assert.match(stdout, /GET \/health after shutdown\s+connection refused/);
});

test('example 2 (medkit) runs and reports availability honestly', { timeout: 180_000 }, async () => {
  const { code, stdout } = await run(join(root, 'examples', '02-medkit', 'run.mjs'));
  assert.equal(code, 0, 'example must exit 0 even without FFmpeg');
  assert.match(stdout, /ffmpeg available\s+(true|false)/);
  if (stdout.includes('ffmpeg available                   true')) {
    assert.match(stdout, /encode exit code\s+0/);
    assert.match(stdout, /container\s+mp4/);
    assert.match(stdout, /probe invalid input\s+unknown video=null/);
    assert.match(stdout, /font present\s+true/);
    assert.match(stdout, /drawtext render works\s+yes/);
    assert.match(stdout, /output starts with ftyp\s+ftyp/);
  } else {
    assert.match(stdout, /No usable FFmpeg binary was found\./, 'must explain why it skipped');
  }
});

test('example 2 handles missing FFmpeg without failing', { timeout: 120_000 }, async () => {
  const env = { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin' };
  delete env.FFMPEG_PATH;
  const { code, stdout } = await run(join(root, 'examples', '02-medkit', 'run.mjs'), { env });
  assert.equal(code, 0);
  assert.match(stdout, /ffmpeg available\s+false/);
  assert.match(stdout, /No usable FFmpeg binary was found\./);
  assert.match(stdout, /FFMPEG_PATH=\/usr\/bin\/ffmpeg node examples\/02-medkit\/run\.mjs/);
  assert.match(stdout, /Skipped: encode, probing and drawtext render checks\./);
});

test('example 3 (transcript-utils) produces correct SRT and rejects bad data', { timeout: 120_000 }, async () => {
  const { code, stdout } = await run(join(root, 'examples', '03-transcript-utils', 'run.mjs'));
  assert.equal(code, 0);
  assert.match(stdout, /absolute start #1\s+120/);
  assert.match(stdout, /segments in 120-123s\s+1/);
  assert.match(stdout, /segments in 900-905s\s+0/);
  assert.match(stdout, /1\n00:00:00,000 --> 00:00:02,000\nthis is the hook/);
  assert.match(stdout, /first cue after 1\.25x\s+00:00:00,000 --> 00:00:02,500/);
  assert.match(stdout, /srtBlob of empty input\s+null/);
  assert.match(stdout, /malformed transcript\s+rejected/);
  assert.match(stdout, /disordered words\s+rejected/);
  assert.match(stdout, /zero scale factor\s+rejected/);
});

test('every example exists and is listed in the examples README', async () => {
  const { readFile } = await import('node:fs/promises');
  const readme = await readFile(join(root, 'examples', 'README.md'), 'utf8');
  for (const dir of ['01-media-worker', '02-medkit', '03-transcript-utils']) {
    assert.ok(existsSync(join(root, 'examples', dir, 'run.mjs')), `${dir}/run.mjs must exist`);
    assert.ok(readme.includes(dir), `examples/README.md must reference ${dir}`);
  }
});

// The documented failure mode must stay clear: a missing build exits non-zero
// with the prerequisite command, never an opaque module error.
//
// This uses an ISOLATED fixture: the example script is copied into a temporary
// tree whose repository layout has no dist/ at all. Nothing inside the real
// repository is renamed, moved or deleted, so a killed run cannot leave the
// checkout damaged.
test('examples fail clearly with an actionable message when dist is missing', async () => {
  const { cp, mkdir, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const fixture = await mkdtemp(join(tmpdir(), 'examples-nodist-'));

  try {
    // Build a minimal repository-shaped tree: examples/<case>/run.mjs and an
    // empty packages/<pkg>/ directory (present but without dist/).
    const cases = [
      { dir: '02-medkit', pkg: 'medkit', label: 'medkit' },
      { dir: '03-transcript-utils', pkg: 'transcript-utils', label: 'transcript-utils' },
    ];
    for (const { dir, pkg } of cases) {
      await mkdir(join(fixture, 'examples', dir), { recursive: true });
      await mkdir(join(fixture, 'packages', pkg), { recursive: true });
      await cp(join(root, 'examples', dir, 'run.mjs'), join(fixture, 'examples', dir, 'run.mjs'));
    }

    // Sanity check: the fixture really has no build output before asserting.
    for (const { pkg } of cases) {
      assert.equal(existsSync(join(fixture, 'packages', pkg, 'dist', 'index.js')), false, `${pkg} fixture must have no dist`);
    }

    for (const { dir, label } of cases) {
      const result = await new Promise((resolve) => {
        execFile(process.execPath, [join(fixture, 'examples', dir, 'run.mjs')], { cwd: fixture }, (error, stdout, stderr) => {
          resolve({ code: error?.code ?? 0, stdout, stderr });
        });
      });
      assert.equal(result.code, 2, `${label}: missing build must exit 2`);
      assert.match(result.stderr, new RegExp(`${label} has not been built`), `${label}: must say what is missing`);
      assert.match(result.stderr, /npm ci && npm run build/, `${label}: must give the prerequisite command`);
      assert.match(result.stderr, /Missing: /, `${label}: must print the expected path`);
      // It must fail BEFORE doing any work: no success output.
      assert.equal(result.stdout, '', `${label}: must not print example output when the build is missing`);
    }

    // The real repository must be untouched by this test.
    for (const { pkg } of cases) {
      assert.ok(existsSync(join(root, 'packages', pkg, 'dist', 'index.js')), `real ${pkg} dist must still exist`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
