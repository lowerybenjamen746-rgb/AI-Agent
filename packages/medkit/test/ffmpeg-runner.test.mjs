import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createFFmpegRuntime, defaultTextAssetRoot, detectFFmpeg, runFFmpeg, stageTextAssets } from '../dist/ffmpeg-runner.js';

const probe = detectFFmpeg({ requiredFilters: [], requiredEncoders: [] });
const hasFFmpeg = probe.available === true;

test('discovery resolves a real FFmpeg build on this host', { skip: !hasFFmpeg && 'no ffmpeg available' }, () => {
  assert.equal(probe.available, true);
  assert.match(probe.version ?? '', /ffmpeg version/i);
  assert.ok(['FFMPEG_PATH', 'ffmpeg-static', 'PATH', 'known location'].includes(probe.source));
});

test('an explicit FFMPEG_PATH is authoritative and a broken path fails clearly', () => {
  const broken = detectFFmpeg({ env: { FFMPEG_PATH: '/nonexistent/ffmpeg' } });
  assert.equal(broken.available, false);
  assert.equal(broken.source, 'none');
  assert.match(broken.reason, /No usable FFmpeg binary|not an executable/);
});

test('a missing required filter is named and the build is refused', { skip: !hasFFmpeg && 'no ffmpeg available' }, () => {
  const capability = detectFFmpeg({ requiredFilters: ['definitely_not_a_filter_xyz'] });
  assert.equal(capability.available, false);
  assert.deepEqual(capability.missingFilters, ['definitely_not_a_filter_xyz']);
  assert.match(capability.reason, /missing filters: definitely_not_a_filter_xyz/);
});

test('exec runs a real encode and reports exit code 0', { skip: !hasFFmpeg && 'no ffmpeg available' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medkit-run-'));
  try {
    const logs = [];
    const code = await runFFmpeg({
      binary: probe.binary,
      args: ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1', '-frames:v', '1', '-f', 'null', '-'],
      workingDirectory: directory,
      timeoutMs: 30_000,
      onLog: (event) => logs.push(event.message),
    });
    assert.equal(code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a bad argument list fails with a non-zero exit code, not a crash', { skip: !hasFFmpeg && 'no ffmpeg available' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medkit-run-'));
  try {
    const code = await runFFmpeg({
      binary: probe.binary,
      args: ['-hide_banner', '-v', 'error', '-f', 'nope_not_a_format', '-i', 'x', '-f', 'null', '-'],
      workingDirectory: directory,
      timeoutMs: 30_000,
    });
    assert.notEqual(code, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the wall-clock budget kills a stuck invocation with a clear error', { skip: !hasFFmpeg && 'no ffmpeg available' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medkit-run-'));
  try {
    await assert.rejects(
      () => runFFmpeg({
        binary: probe.binary,
        args: ['-hide_banner', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=duration=600', '-f', 'null', '-'],
        workingDirectory: directory,
        timeoutMs: 700,
      }),
      /exceeded the 700ms budget/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('aborting cancels a running invocation', { skip: !hasFFmpeg && 'no ffmpeg available' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medkit-run-'));
  try {
    const controller = new AbortController();
    const running = runFFmpeg({
      binary: probe.binary,
      args: ['-hide_banner', '-v', 'error', '-re', '-f', 'lavfi', '-i', 'testsrc=duration=600', '-f', 'null', '-'],
      workingDirectory: directory,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 300);
    await assert.rejects(() => running, /cancelled by test/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the runtime adapter writes, lists and deletes files in its workspace', { skip: !hasFFmpeg && 'no ffmpeg available' }, async () => {
  const runtime = createFFmpegRuntime(probe);
  assert.ok(runtime);
  assert.equal(await runtime.writeFile('note.txt', 'hello'), true);
  const read = await runtime.readFile('note.txt');
  assert.equal(Buffer.from(read).toString(), 'hello');
  assert.equal(await runtime.deleteFile('note.txt'), true);
  assert.equal(await runtime.deleteFile('note.txt'), false);
});

test('createFFmpegRuntime returns null when no capability is available', () => {
  assert.equal(createFFmpegRuntime({ available: false, binary: null, source: 'none', version: null, missingFilters: [], missingEncoders: [], textRenderError: null, staged: false, reason: 'none' }), null);
});

// Asset resolution must not depend on the caller's working directory: as an
// installed dependency, process.cwd() is whatever project consumed medkit.
test('text assets resolve relative to the installed module, not the working directory', async () => {
  const root = defaultTextAssetRoot();
  assert.ok(existsSync(join(root, 'fonts.conf')), `fonts.conf missing at ${root}`);
  assert.ok(existsSync(join(root, 'fonts', 'drawtext.ttf')), `drawtext.ttf missing at ${root}`);

  const previous = process.cwd();
  const foreign = await mkdtemp(join(tmpdir(), 'medkit-foreign-cwd-'));
  try {
    process.chdir(foreign);
    assert.equal(process.cwd(), foreign);
    const staged = stageTextAssets();
    assert.ok(existsSync(staged.env.FONTCONFIG_FILE), 'staged fontconfig must exist');
    assert.ok(existsSync(staged.env.FONTCONFIG_PATH), 'staged font directory must exist');
    assert.equal(staged.env.FONTCONFIG_PATH, staged.directory);
  } finally {
    process.chdir(previous);
    await rm(foreign, { recursive: true, force: true });
  }
});

test('an explicit cwd override is honoured and a missing asset root fails with the searched path', async () => {
  const empty = await mkdtemp(join(tmpdir(), 'medkit-no-assets-'));
  try {
    assert.throws(() => stageTextAssets({ cwd: empty, fontDirToken: '@NOT_IN_TEMPLATE@' }), /Bundled native text assets are missing under|missing @NOT_IN_TEMPLATE@/);
    assert.ok(empty.startsWith(tmpdir()));
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test('a real drawtext render works with the module-resolved assets from a foreign cwd', { skip: !hasFFmpeg && 'no ffmpeg available' }, async () => {
  const previous = process.cwd();
  const foreign = await mkdtemp(join(tmpdir(), 'medkit-foreign-render-'));
  try {
    process.chdir(foreign);
    const capability = detectFFmpeg({ checkTextRender: true });
    assert.equal(capability.available, true, capability.reason ?? 'text render failed');
    assert.equal(capability.textRenderError, null);
  } finally {
    process.chdir(previous);
    await rm(foreign, { recursive: true, force: true });
  }
});

// Documented cache semantics: staging happens once per process. A second call
// with a VALID but different root returns the first staged result, while an
// invalid root still throws. Pinning this prevents the docs drifting.
test('text staging is per-process: the first successful root wins and is reused', async () => {
  const first = stageTextAssets();
  assert.equal(stageTextAssets(), first, 'repeat call returns the same staged environment');

  const alternate = await mkdtemp(join(tmpdir(), 'medkit-alt-assets-'));
  try {
    await mkdir(join(alternate, 'assets', 'ffmpeg', 'fonts'), { recursive: true });
    const source = defaultTextAssetRoot();
    await copyFile(join(source, 'fonts.conf'), join(alternate, 'assets', 'ffmpeg', 'fonts.conf'));
    await copyFile(join(source, 'fonts', 'drawtext.ttf'), join(alternate, 'assets', 'ffmpeg', 'fonts', 'drawtext.ttf'));

    const second = stageTextAssets({ cwd: alternate });
    assert.equal(second, first, 'a valid alternate root reuses the first staging');
    assert.notEqual(second.directory.startsWith(alternate), true, 'staging is not recreated for the alternate root');

    assert.throws(() => stageTextAssets({ cwd: join(alternate, 'missing') }), /text assets are missing under/, 'an invalid root still fails');
  } finally {
    await rm(alternate, { recursive: true, force: true });
  }
});
