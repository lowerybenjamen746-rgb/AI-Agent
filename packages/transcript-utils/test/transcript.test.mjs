import assert from 'node:assert/strict';
import test from 'node:test';

import {
  absoluteSegment,
  assertTranscriptTimestamps,
  srtBlob,
  absoluteSegments,
  canonicalTranscriptToSrt,
  clipSegmentsToRange,
  cuesToSrt,
  estimatedSegmentsFromText,
  formatSrtTimestamp,
  normalizeSegmentTimeline,
  parseSrtTimestamp,
  scaleSrtTimestamps,
  selectTranscriptSegments,
  sortSegmentsChronologically,
} from '../dist/index.js';

const chunk = { index: 2, startSeconds: 120, endSeconds: 180, durationSeconds: 60, subdivisionDepth: 0 };

const segment = (overrides = {}) => ({
  text: 'hello world',
  start: 1,
  end: 3,
  words: [
    { text: 'hello', start: 1, end: 2 },
    { text: 'world', start: 2, end: 3 },
  ],
  provider: 'test',
  chunkIndex: 0,
  timestampSource: 'word',
  confidence: null,
  metadata: {},
  ...overrides,
});

test('chunk-local timings map to absolute source seconds exactly once', () => {
  const absolute = absoluteSegment(segment(), { chunk, provider: 'test' });
  assert.equal(absolute.start, 121);
  assert.equal(absolute.end, 123);
  assert.deepEqual(absolute.words.map((word) => word.start), [121, 122]);
  assert.equal(absolute.chunkIndex, 2);
});

test('a provider end time past the window is clamped, not leaked into the next chunk', () => {
  const absolute = absoluteSegment(segment({ start: 55, end: 70, words: [] }), { chunk, provider: 'test' });
  assert.equal(absolute.start, 175);
  assert.equal(absolute.end, 180);
});

test('a sub-millisecond word span is kept positive instead of collapsing to zero length', () => {
  const absolute = absoluteSegment(segment({ words: [{ text: 'a', start: 1, end: 1.0001 }] }), { chunk, provider: 'test' });
  assert.ok(absolute.words[0].end > absolute.words[0].start);
});

test('sorting is chronological with a deterministic chunk tie-break', () => {
  const sorted = sortSegmentsChronologically([
    segment({ start: 5, end: 6, chunkIndex: 1 }),
    segment({ start: 1, end: 2, chunkIndex: 1 }),
    segment({ start: 1, end: 2, chunkIndex: 0 }),
  ]);
  assert.deepEqual(sorted.map((entry) => entry.chunkIndex), [0, 1, 1]);
  assert.deepEqual(sorted.map((entry) => entry.start), [1, 1, 5]);
});

test('text without timings is filled proportionally and marked estimated', () => {
  const estimated = estimatedSegmentsFromText('One. Two. Three.', chunk);
  assert.equal(estimated.length, 3);
  assert.ok(estimated.every((entry) => entry.timestampSource === 'estimated'));
  assert.equal(estimated[0].start, 0);
  assert.ok(Math.abs(estimated[estimated.length - 1].end - 60) < 1e-6);
  // Share is word-count proportion (three one-word sentences over a 60 s window).
  assert.deepEqual(absoluteSegments(estimated, { chunk, provider: 'test' }).map((entry) => entry.start), [120, 140, 160]);
});

test('disordered word timings are repaired into an ordered, positive timeline', () => {
  const repaired = normalizeSegmentTimeline(
    [{ text: 'b', start: 2, end: 3 }, { text: 'a', start: 1, end: 2 }, { text: 'c', start: 5, end: 5 }],
    { start: 0, end: 4 },
  );
  assert.deepEqual(repaired.map((word) => word.text), ['a', 'b']);
  assert.equal(repaired[0].start, 1);
  assert.equal(repaired[1].end, 3);
});

test('a clean timeline is returned unchanged (same objects)', () => {
  const words = [{ text: 'a', start: 1, end: 2 }, { text: 'b', start: 2, end: 3 }];
  const result = normalizeSegmentTimeline(words, { start: 0, end: 4 });
  assert.deepEqual(result, words);
});

test('segment selection keeps only speech overlapping the window and clamps its edges', () => {
  const at = (start, end) => segment({ start, end, words: [{ text: 'hello', start, end: (start + end) / 2 }, { text: 'world', start: (start + end) / 2, end }] });
  const segments = [at(0, 2), at(10, 12), at(100, 102)];
  const selected = selectTranscriptSegments(segments, { startSeconds: 1, endSeconds: 11 });
  assert.equal(selected.length, 2);
  assert.equal(selected[0].start, 1);
  assert.equal(selected[1].end, 11);
});

test('malformed timestamps are rejected instead of silently accepted', () => {
  assert.throws(() => selectTranscriptSegments([segment({ start: 3, end: 2 })], { startSeconds: 0, endSeconds: 10 }), /Malformed transcript segment timestamps/);
  assert.throws(
    () => selectTranscriptSegments([segment({ words: [{ text: 'x', start: 2, end: 1 }] })], { startSeconds: 0, endSeconds: 10 }),
    /Malformed transcript word timestamps/,
  );
});

test('SRT timestamps round-trip in the only shape the format accepts', () => {
  assert.equal(formatSrtTimestamp(75.5), '00:01:15,500');
  assert.equal(formatSrtTimestamp(-3), '00:00:00,000');
  assert.equal(parseSrtTimestamp('00:01:15,500'), 75.5);
  assert.ok(Number.isNaN(parseSrtTimestamp('1:15')));
});

test('cue generation converts absolute segments into clip-relative cues', () => {
  const at = (start, end) => segment({ start, end, words: [{ text: 'hello', start, end: (start + end) / 2 }, { text: 'world', start: (start + end) / 2, end }] });
  const cues = clipSegmentsToRange([at(10, 12), at(30, 32)], { startSeconds: 10, endSeconds: 20 });
  assert.deepEqual(cues, [{ startSeconds: 0, endSeconds: 2, text: 'hello world' }]);
});

test('an empty cue set produces an empty string, never an empty subtitle file', () => {
  assert.equal(canonicalTranscriptToSrt({ segments: [], startSeconds: 0, endSeconds: 10 }), '');
  assert.equal(cuesToSrt([]), '');
});

test('cues serialise as numbered SRT blocks with blank-line separation', () => {
  const srt = cuesToSrt([{ startSeconds: 0, endSeconds: 1.5, text: 'first' }, { startSeconds: 2, endSeconds: 3, text: 'second' }]);
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:01,500\nfirst\n\n2\n00:00:02,000 --> 00:00:03,000\nsecond\n');
});

test('re-timing an SRT scales every cue and leaves text and indices alone', () => {
  const original = '1\n00:00:01,000 --> 00:00:02,000\nkeep me\n';
  assert.equal(scaleSrtTimestamps(original, 1), original);
  assert.equal(scaleSrtTimestamps(original, 2), '1\n00:00:02,000 --> 00:00:04,000\nkeep me\n');
  assert.throws(() => scaleSrtTimestamps(original, 0), /positive number/);
});

test('an SRT that gains an end before its start is floored to a positive event', () => {
  const scaled = scaleSrtTimestamps('1\n00:00:00,100 --> 00:00:00,200\nx\n', 0.0001);
  assert.match(scaled, /00:00:00,000 --> 00:00:00,001/);
});

test('srtBlob returns null for empty output and a text blob otherwise', async () => {
  assert.equal(srtBlob(''), null);
  assert.equal(srtBlob('   \n'), null);
  const blob = srtBlob('1\n00:00:00,000 --> 00:00:01,000\nhi');
  assert.ok(blob instanceof Blob);
  assert.equal(blob.type, 'text/plain');
  assert.equal(await blob.text(), '1\n00:00:00,000 --> 00:00:01,000\nhi\n');
});

test('assertTranscriptTimestamps accepts valid segments and rejects each malformed shape', () => {
  const valid = [segment({ start: 0, end: 1, words: [{ text: 'a', start: 0, end: 1 }] })];
  assert.doesNotThrow(() => assertTranscriptTimestamps(valid));

  for (const bad of [
    { start: 2, end: 1, words: [] },
    { start: Number.NaN, end: 1, words: [] },
    { start: 0, end: 1, words: [{ text: 'a', start: 0.5, end: 0.4 }] },
    { start: 0, end: 1, words: [{ text: 'a', start: 0, end: 2 }] },
    { start: 0, end: 1, words: [{ text: 'a', start: 0.8, end: 1 }, { text: 'b', start: 0.2, end: 0.9 }] },
  ]) {
    assert.throws(() => assertTranscriptTimestamps([segment(bad)]), /Malformed transcript/, JSON.stringify(bad));
  }
});

// The README example is executed verbatim so documentation cannot drift from
// the exported API (audit finding 4).
test('the transcript-utils README example produces the documented result', () => {
  const providerSegments = [{ text: 'hello world', start: 0, end: 2, timestampSource: 'segment' }];
  const segments = absoluteSegments(providerSegments, {
    chunk: { index: 2, startSeconds: 120, endSeconds: 180, durationSeconds: 60, subdivisionDepth: 0 },
    provider: 'whisper',
  });
  const selected = selectTranscriptSegments(segments, { startSeconds: 120, endSeconds: 126 });
  assert.equal(selected.length, 1, 'the documented window must contain the spoken segment');
  assert.equal(segments[0].start, 120);

  const srt = canonicalTranscriptToSrt({ segments, startSeconds: 120, endSeconds: 126 });
  assert.equal(srt, '1\n00:00:00,000 --> 00:00:02,000\nhello world\n');
});
