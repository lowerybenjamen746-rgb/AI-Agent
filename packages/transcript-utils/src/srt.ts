/**
 * Clip-relative subtitles (SRT).
 *
 * A canonical transcript is stored in ABSOLUTE source seconds, but a rendered
 * clip's timeline starts at zero. This module is the only place that converts
 * between the two, so a cue can never be left in source-global time (which would
 * place every caption after the clip end) and the clip's offset can never be
 * applied twice.
 *
 * Rules, all of them deliberate:
 *  - only speech that overlaps the candidate window is emitted;
 *  - include a word iff end > clip start AND start < clip end (positive overlap);
 *  - segment-only text is deterministically interpolated within its own bounds;
 *  - only selected words are emitted; edge times are clamped to the clip;
 *  - every cue is relative to the clip's first frame;
 *  - cues are chronological and duplicates left by the seam-overlap stage are
 *    collapsed;
 *  - an empty transcript, or a window with no speech in it, yields an empty
 *    string, which callers treat as "no subtitle asset" instead of burning an
 *    empty file.
 */
import type { CanonicalSegment } from './types.js';
import { selectTranscriptSegments, type SelectedTranscriptSegment } from './selected-words.js';

export interface SubtitleCue {
  /** Clip-relative seconds. */
  startSeconds: number;
  /** Clip-relative seconds. */
  endSeconds: number;
  text: string;
}

/** Shortest cue written to the SRT; avoids zero-length subtitle events. */
export const MIN_CUE_SECONDS = 0.2;

export interface SubtitleRange {
  /** Absolute source seconds of the clip's first frame. */
  startSeconds: number;
  /** Absolute source seconds of the clip's end. */
  endSeconds: number;
}

function round(time: number): number {
  return Math.round(time * 1000) / 1000;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Clip one segment to the window, using the provider's own word timings when the
 * segment crosses a boundary (a segment sitting entirely inside the window is
 * emitted with its measured bounds untouched).
 */
function cueForSegment(segment: SelectedTranscriptSegment, range: SubtitleRange): SubtitleCue | null {
  const text = normalizeText(segment.text);
  if (text.length === 0) return null;

  const inside = segment.start >= range.startSeconds && segment.end <= range.endSeconds;
  let start = segment.start;
  let end = segment.end;

  if (!inside) {
    start = Math.max(start, range.startSeconds);
    end = Math.min(end, range.endSeconds);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (end <= start) return null;

  const clipDuration = range.endSeconds - range.startSeconds;
  const boundedStart = Math.max(0, start - range.startSeconds);
  // A cue whose measured span collapses at the very edge of the window is still
  // captioned: it is padded to the readable minimum instead of being dropped, so
  // a boundary word is never silently lost.
  const boundedEnd = Math.min(
    Math.max(end - range.startSeconds, boundedStart + MIN_CUE_SECONDS),
    clipDuration,
  );
  if (boundedEnd <= boundedStart) return null;

  const startSeconds = round(boundedStart);
  const endSeconds = Math.min(round(boundedEnd), Math.floor(clipDuration * 1000) / 1000);
  if (endSeconds <= startSeconds) return null;
  return { startSeconds, endSeconds, text };
}

/** Every cue of the transcript that belongs to the candidate window. */
export function clipSegmentsToRange(
  segments: readonly CanonicalSegment[],
  range: SubtitleRange,
): SubtitleCue[] {
  if (!(range.endSeconds > range.startSeconds)) return [];

  const cues: SubtitleCue[] = [];
  for (const segment of selectTranscriptSegments(segments, range)) {
    const cue = cueForSegment(segment, range);
    if (!cue) continue;
    const previous = cues[cues.length - 1];
    if (
      previous &&
      previous.startSeconds === cue.startSeconds &&
      previous.endSeconds === cue.endSeconds &&
      previous.text === cue.text
    ) {
      continue;
    }
    cues.push(cue);
  }

  return cues;
}

/** `HH:MM:SS,mmm`, the only timestamp shape SRT accepts. */
export function formatSrtTimestamp(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const totalMs = Math.round(safe * 1000);
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  const pad = (value: number, size = 2): string => String(value).padStart(size, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)},${pad(ms, 3)}`;
}

/** Parse the only timestamp shape SRT accepts (`HH:MM:SS,mmm`) back into seconds. */
export function parseSrtTimestamp(timestamp: string): number {
  const match = /^(\d{1,3}):(\d{2}):(\d{2}),(\d{3})$/.exec(timestamp.trim());
  if (!match) return Number.NaN;
  return (
    Number(match[1]) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

/** Serialise cues as a valid SRT document. An empty cue set produces an empty string. */
export function cuesToSrt(cues: readonly SubtitleCue[]): string {
  if (cues.length === 0) return '';

  const blocks = cues.map((cue, index) => {
    const start = formatSrtTimestamp(cue.startSeconds);
    // SRT rejects an end at or before the start, so the readable minimum is
    // enforced here as well as in the cue builder.
    const end = formatSrtTimestamp(Math.max(cue.endSeconds, cue.startSeconds + 0.001));
    return `${index + 1}\n${start} --> ${end}\n${cue.text}`;
  });

  return `${blocks.join('\n\n')}\n`;
}

/**
 * Re-time an SRT document onto a uniformly scaled timeline.
 *
 * Every cue start/end is multiplied by `factor` and re-serialised; cue
 * indices, text and blank lines pass through untouched. This is the conversion
 * a subtitle burn needs when a duration-changing pass ran between the moment
 * the cues were generated (candidate time) and the moment they are burned: a
 * cue at candidate second `t` must be written at `t * factor` to sit on its
 * own frame in the retimed output.
 *
 * A `factor` of 1 returns the document byte-identical. A transformed cue stays
 * proportional to its own frames (padding it back out to a "readable" length
 * would make it outlive the speech it captions); the only floor applied is the
 * format's own - an SRT event needs an end strictly after its start.
 */
export function scaleSrtTimestamps(srt: string, factor: number): string {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error(`scaleSrtTimestamps: factor must be a positive number, got ${factor}`);
  }
  if (factor === 1) return srt;

  const lines = srt.split(/\r?\n/);
  const timing = /^\s*(\d{1,3}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{1,3}:\d{2}:\d{2},\d{3})\s*$/;
  for (let i = 0; i < lines.length; i += 1) {
    const match = timing.exec(lines[i] ?? '');
    if (!match) continue;
    const start = Math.max(0, parseSrtTimestamp(match[1]) * factor);
    const scaledEnd = Math.max(0, parseSrtTimestamp(match[2]) * factor);
    const end = Math.max(scaledEnd, start + 0.001);
    lines[i] = `${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}`;
  }
  return lines.join('\n');
}

/**
 * Build the SRT the render stage burns into the selected clip.
 *
 * `segments` are the canonical transcript's absolute-timed segments; the result
 * is expressed in clip-relative time and is empty when the window holds no
 * speech.
 */
export function canonicalTranscriptToSrt(input: {
  segments: readonly CanonicalSegment[];
  startSeconds: number;
  endSeconds: number;
}): string {
  return cuesToSrt(
    clipSegmentsToRange(input.segments, {
      startSeconds: input.startSeconds,
      endSeconds: input.endSeconds,
    }),
  );
}

/** Wrap SRT text as the Blob `fullAutoEdit` expects, or null when there is none. */
export function srtBlob(srt: string): Blob | null {
  const text = srt.trim();
  if (text.length === 0) return null;
  return new Blob([`${text}\n`], { type: 'text/plain' });
}
