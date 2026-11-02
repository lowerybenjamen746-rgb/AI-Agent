/**
 * Timestamp math.
 *
 * A provider only knows times relative to the audio window it was handed.
 * `absoluteSegment` adds the window's source offset exactly once, so the
 * canonical transcript always holds ABSOLUTE source timestamps that stay correct
 * across overlap removal, merging, provider fallback and chunk reordering.
 *
 * No `wordOffset * secondsPerWord` estimate is produced here: when a provider
 * supplies word or segment timings those are preserved verbatim, and when it
 * supplies none at all the window is filled proportionally and explicitly marked
 * `estimated` so no consumer can mistake it for a measurement.
 */
import type {
  CanonicalSegment,
  ChunkBoundary,
  ProviderSegment,
  TimestampSource,
  TranscriptionProviderId,
} from './types.js';
import { roundTime } from './types.js';

export interface AbsoluteSegmentOptions {
  chunk: ChunkBoundary;
  provider: TranscriptionProviderId;
  metadata?: Record<string, string | number | boolean | null>;
}

/** Provider-local seconds -> absolute source seconds. */
export function toAbsoluteSeconds(localSeconds: number, chunkStartSeconds: number): number {
  return roundTime(localSeconds + chunkStartSeconds);
}

/** Most granular timing a set of provider segments carries. */
export function mostGranularTimestampSource(
  segments: readonly ProviderSegment[]
): TimestampSource {
  if (segments.some((segment) => segment.timestampSource === 'word')) return 'word';
  if (segments.some((segment) => segment.timestampSource === 'segment')) return 'segment';
  return 'estimated';
}

/**
 * Map one provider segment into the canonical model.
 *
 * The segment's own times are clamped to the window it came from: a provider can
 * report an end time slightly past the window (Whisper pads the last segment),
 * and letting that through would leak a time that belongs to the next window.
 */
export function absoluteSegment(
  segment: ProviderSegment,
  options: AbsoluteSegmentOptions
): CanonicalSegment {
  const { chunk, provider } = options;
  const rawStart = Math.max(segment.start, 0);
  const rawEnd = Math.max(segment.end, rawStart);
  const boundedEnd = Math.min(rawEnd, chunk.durationSeconds);

  // Each value is rounded to milliseconds independently, so a positive but
  // sub-millisecond provider span would collapse to a zero-length word. Keep a
  // one-millisecond span inside the window instead of emitting invalid timing.
  const words = (segment.words ?? [])
    .map((word) => {
      const start = toAbsoluteSeconds(Math.min(Math.max(word.start, 0), chunk.durationSeconds), chunk.startSeconds);
      const end = toAbsoluteSeconds(Math.min(Math.max(word.end, 0), chunk.durationSeconds), chunk.startSeconds);
      return { text: word.text, start, end: end > start ? end : roundTime(start + 0.001) };
    })
    .filter((word) => word.text.trim().length > 0);

  return {
    text: segment.text.trim(),
    start: toAbsoluteSeconds(rawStart, chunk.startSeconds),
    end: toAbsoluteSeconds(boundedEnd, chunk.startSeconds),
    words,
    provider,
    chunkIndex: chunk.index,
    timestampSource: segment.timestampSource,
    confidence: typeof segment.confidence === 'number' ? segment.confidence : null,
    metadata: {
      subdivisionDepth: chunk.subdivisionDepth,
      providerLocalStart: roundTime(rawStart),
      providerLocalEnd: roundTime(rawEnd),
      ...(options.metadata ?? {}),
    },
  };
}

/** Map a whole provider result, dropping empty segments. */
export function absoluteSegments(
  segments: readonly ProviderSegment[],
  options: AbsoluteSegmentOptions
): CanonicalSegment[] {
  return segments
    .map((segment) => absoluteSegment(segment, options))
    .filter((segment) => segment.text.length > 0);
}

/**
 * Chronological order, with a deterministic tie-break.
 *
 * Equal start times happen legitimately (a provider can emit two segments in the
 * same millisecond), so the sort is stable on (start, end, chunkIndex) rather
 * than relying on the input order of an arbitrary provider.
 */
export function sortSegmentsChronologically(
  segments: readonly CanonicalSegment[]
): CanonicalSegment[] {
  return [...segments].sort((a, b) => {
    if (a.start !== b.start) return a.start - b.start;
    if (a.end !== b.end) return a.end - b.end;
    return a.chunkIndex - b.chunkIndex;
  });
}

/** Split text into sentences for the estimate path only. */
export function splitForEstimation(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function countWordsInText(text: string): number {
  return text.split(/\s+/).filter((word) => word.length > 0).length;
}

/**
 * Fill a window a provider returned text for but no timing.
 *
 * This is the ONLY place a timing is derived rather than measured, it happens
 * only for a provider that supplied none, and every segment it produces is
 * marked `estimated`. It exists so a provider without timestamp support still
 * yields a usable, honestly-labelled transcript instead of a failure; the
 * configured provider order keeps such a provider last precisely so this path is
 * not the norm.
 */
export function estimatedSegmentsFromText(text: string, chunk: ChunkBoundary): ProviderSegment[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  const pieces = splitForEstimation(trimmed);
  const units = pieces.length > 0 ? pieces : [trimmed];
  const counts = units.map((unit) => Math.max(1, countWordsInText(unit)));
  const total = counts.reduce((sum, count) => sum + count, 0);

  let cursor = 0;
  return units.map((unit, index) => {
    const share = (counts[index] ?? 1) / total;
    const start = cursor;
    cursor += share * chunk.durationSeconds;
    return {
      text: unit,
      start: roundTime(start),
      end: roundTime(cursor),
      timestampSource: 'estimated' as const,
      confidence: null,
    };
  });
}
