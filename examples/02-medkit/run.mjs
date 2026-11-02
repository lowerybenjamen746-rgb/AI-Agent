#!/usr/bin/env node
// Example 2 — medkit: detection, probing, a real encode, and the failure paths.
//
// Prerequisite (medkit is TypeScript and must be compiled first):
//   npm ci && npm run build
//
// Then, from the repository root:
//   FFMPEG_PATH=/usr/bin/ffmpeg node examples/02-medkit/run.mjs
//
// Without any FFmpeg binary the script still runs: detection reports why, the
// encode and probe steps are skipped, and the exit code stays 0. A genuinely
// broken build or an unexpected error exits non-zero.

import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_ENTRY = join(ROOT, 'packages', 'medkit', 'dist', 'index.js');

// Fail with the exact command instead of an opaque ERR_MODULE_NOT_FOUND.
if (!existsSync(DIST_ENTRY)) {
  console.error('medkit has not been built, so this example cannot run.\n');
  console.error('  Missing: ' + DIST_ENTRY + '\n');
  console.error('Run this first, from the repository root:\n');
  console.error('  npm ci && npm run build\n');
  process.exit(2);
}

const {
  buildAspectCropFilter,
  defaultTextAssetRoot,
  detectFFmpeg,
  probeVideoFileByPath,
  runFFmpeg,
  stageTextAssets,
} = await import(DIST_ENTRY);

const log = (label, value) => console.log(`${label.padEnd(34)} ${value}`);

// ---------------------------------------------------------------------------
// 1. Detect FFmpeg. FFMPEG_PATH is authoritative; without it, PATH and known
//    install locations are tried. A build missing a required capability is
//    refused by name rather than silently replaced.
// ---------------------------------------------------------------------------
const capability = detectFFmpeg();
log('ffmpeg available', capability.available);
log('ffmpeg source', capability.source);
log('ffmpeg version', capability.version ? capability.version.slice(0, 60) : 'none');

if (!capability.available) {
  // Concise and actionable: what is missing, how to fix it, what was skipped.
  console.log('\nNo usable FFmpeg binary was found.');
  console.log('  Fix: install FFmpeg, or point FFMPEG_PATH at a build:');
  console.log('       FFMPEG_PATH=/usr/bin/ffmpeg node examples/02-medkit/run.mjs');
  console.log('  Skipped: encode, probing and drawtext render checks.');
  console.log('  Still usable: detection/refusal logic and pure helpers.\n');
} else {
  // Missing filters are reported, not guessed at.
  const impossible = detectFFmpeg({ requiredFilters: ['definitely_not_a_filter'] });
  log('missing-filter detection', `${impossible.available} ${JSON.stringify(impossible.missingFilters)}`);

  const workdir = await mkdtemp(join(tmpdir(), 'medkit-example-'));
  try {
    // -----------------------------------------------------------------------
    // 2. Real FFmpeg operation: generate a small MP4 with a video stream.
    // -----------------------------------------------------------------------
    const source = join(workdir, 'source.mp4');
    const exitCode = await runFFmpeg({
      binary: capability.binary,
      args: [
        '-hide_banner', '-v', 'error',
        '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=25',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', source,
      ],
      workingDirectory: workdir,
      timeoutMs: 60_000,
    });
    log('encode exit code', exitCode);

    // -----------------------------------------------------------------------
    // 3. Probe the produced file. The probe walks MP4 boxes; it decodes
    //    nothing, so cost scales with metadata, not with video length.
    // -----------------------------------------------------------------------
    const info = await probeVideoFileByPath(source);
    log('container', info?.container);
    log('video width x height', info?.video ? `${info.video.width}x${info.video.height}` : 'unknown');
    log('video duration (seconds)', info?.video?.durationSeconds ?? 'unknown');
    log('size on disk (bytes)', info?.sizeBytes);

    // A missing file is `null`, not an exception and not a zero.
    log('probe missing file', await probeVideoFileByPath(join(workdir, 'nope.mp4')));

    // Invalid input: a text file is not a video.
    const bogus = join(workdir, 'not-a-video.mp4');
    await writeFile(bogus, 'this is definitely not an mp4');
    const bogusInfo = await probeVideoFileByPath(bogus);
    log('probe invalid input', `${bogusInfo?.container} video=${bogusInfo?.video}`);

    // -----------------------------------------------------------------------
    // 4. Invalid FFmpeg arguments fail with a non-zero exit code, not a crash.
    // -----------------------------------------------------------------------
    const badExit = await runFFmpeg({
      binary: capability.binary,
      args: ['-hide_banner', '-v', 'error', '-f', 'not_a_format', '-i', 'x', '-f', 'null', '-'],
      workingDirectory: workdir,
      timeoutMs: 30_000,
    });
    log('invalid ffmpeg args exit', badExit);

    // -----------------------------------------------------------------------
    // 5. Text assets resolve from the INSTALLED MODULE, not the working
    //    directory, so this works from any consumer project.
    // -----------------------------------------------------------------------
    const assetRoot = defaultTextAssetRoot();
    log('resolved asset root', assetRoot);
    log('font present', existsSync(join(assetRoot, 'fonts', 'drawtext.ttf')));
    const staged = stageTextAssets();
    log('staged fontconfig', staged.env.FONTCONFIG_FILE);
    const textCapability = detectFFmpeg({ checkTextRender: true });
    log('drawtext render works', textCapability.available ? 'yes' : textCapability.textRenderError);

    // -----------------------------------------------------------------------
    // 6. Aspect crop filter for a vertical render.
    // -----------------------------------------------------------------------
    log('9:16 crop filter', `${buildAspectCropFilter('9:16').slice(0, 46)}…`);

    // Prove the generated file is a real MP4, not an empty stub.
    const bytes = await readFile(source);
    log('output starts with ftyp', bytes.subarray(4, 8).toString('ascii'));
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

// Pure helpers work with or without FFmpeg.
log('9:16 filter (pure)', `${buildAspectCropFilter('9:16').slice(0, 46)}…`);
log('asset root (pure)', defaultTextAssetRoot());

console.log('\nDone.');
