#!/usr/bin/env node
// Example 3 — transcript-utils: absolute timings, selection, SRT, failure paths.
//
// Prerequisite (TypeScript must be compiled first):
//   npm ci && npm run build
//
// Then, from the repository root:
//   node examples/03-transcript-utils/run.mjs
//
// transcript-utils has no runtime dependencies and no FFmpeg requirement.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST_ENTRY = join(ROOT, 'packages', 'transcript-utils', 'dist', 'index.js');

// Fail with the exact command instead of an opaque ERR_MODULE_NOT_FOUND.
if (!existsSync(DIST_ENTRY)) {
  console.error('transcript-utils has not been built, so this example cannot run.\n');
  console.error('  Missing: ' + DIST_ENTRY + '\n');
  console.error('Run this first, from the repository root:\n');
  console.error('  npm ci && npm run build\n');
  process.exit(2);
}

const {
  absoluteSegments,
  assertTranscriptTimestamps,
  canonicalTranscriptToSrt,
  scaleSrtTimestamps,
  selectTranscriptSegments,
  srtBlob,
} = await import(DIST_ENTRY);

const log = (label, value) => console.log(`${label.padEnd(32)} ${value}`);

// A speech-to-text provider returns times relative to the audio window it was
// given, not to the source. This is chunk 2 of a 60-second window starting at
// 120 s: provider times 0-2 s are 120-122 s in the source.
const chunk = { index: 2, startSeconds: 120, endSeconds: 180, durationSeconds: 60, subdivisionDepth: 0 };

const providerSegments = [
  { text: 'this is the hook', start: 0, end: 2, timestampSource: 'segment' },
  { text: 'and here is the rest', start: 3, end: 6, timestampSource: 'segment' },
];

// 1. Map provider-local times to absolute source seconds (offset applied once).
const segments = absoluteSegments(providerSegments, { chunk, provider: 'example-asr' });
log('absolute start #1', segments[0].start);
log('absolute end   #2', segments[1].end);

// 2. Validate the transcript before trusting it downstream.
assertTranscriptTimestamps(segments);
log('validation', 'passed');

// 3. Select the speech inside the clip window you intend to render.
const window = { startSeconds: 120, endSeconds: 123 };
const selected = selectTranscriptSegments(segments, window);
log('segments in 120-123s', selected.length);
log('first selected text', JSON.stringify(selected[0].text));

// A window with no speech selects nothing — an empty array, not an error.
log('segments in 900-905s', selectTranscriptSegments(segments, { startSeconds: 900, endSeconds: 905 }).length);

// 4. Generate clip-relative SRT: cue times start at zero for the rendered clip.
const srt = canonicalTranscriptToSrt({ segments, startSeconds: 120, endSeconds: 126 });
console.log('\n--- generated SRT ---');
process.stdout.write(srt);
console.log('---------------------');

// 5. Re-time a subtitle file after a duration-changing edit (e.g. 1.25x speed).
const retimed = scaleSrtTimestamps(srt, 1.25);
log('first cue after 1.25x', retimed.split('\n')[1]);

// 6. A Blob for upload/download paths; null when there are no cues.
const blob = srtBlob(srt);
log('srtBlob type / size', `${blob.type} / ${blob.size} bytes`);
log('srtBlob of empty input', srtBlob(''));

// 7. Failure paths: malformed timings are refused instead of silently
//    producing subtitles that drift.
const malformed = [{ text: 'backwards', start: 5, end: 2, words: [], provider: 'x', chunkIndex: 0, timestampSource: 'segment', confidence: null, metadata: {} }];
try {
  assertTranscriptTimestamps(malformed);
  log('malformed transcript', 'ACCEPTED (unexpected)');
} catch (error) {
  log('malformed transcript', `rejected: ${error.message}`);
}

// Words outside their segment are also refused.
const badWords = [{
  text: 'mixed', start: 0, end: 1, provider: 'x', chunkIndex: 0, timestampSource: 'word', confidence: null, metadata: {},
  words: [{ text: 'a', start: 0.8, end: 1 }, { text: 'b', start: 0.2, end: 0.9 }],
}];
try {
  assertTranscriptTimestamps(badWords);
  log('disordered words', 'ACCEPTED (unexpected)');
} catch (error) {
  log('disordered words', `rejected: ${error.message}`);
}

// A non-positive speed factor is a caller error, not a silent no-op.
try {
  scaleSrtTimestamps(srt, 0);
  log('zero scale factor', 'ACCEPTED (unexpected)');
} catch (error) {
  log('zero scale factor', `rejected: ${error.message}`);
}

console.log('\nDone. The SRT above was produced by the package from the listed timings.');
