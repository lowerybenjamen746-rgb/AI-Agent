/**
 * Canonical transcript types.
 *
 * These are the shapes the utilities in this package operate on. They are
 * provider-agnostic: a segment carries absolute source seconds plus whatever
 * timing granularity the provider actually supplied.
 */

/** Provider identifier. Free-form so any ASR backend can be represented. */
export type TranscriptionProviderId = string;

/** Most granular timing a set of segments carries. */
export type TimestampSource = 'word' | 'segment' | 'estimated';

export interface CanonicalWord {
  text: string;
  /** Absolute source seconds. */
  start: number;
  /** Absolute source seconds. */
  end: number;
}

export interface CanonicalSegment {
  text: string;
  /** Absolute source seconds. */
  start: number;
  /** Absolute source seconds. */
  end: number;
  words: CanonicalWord[];
  provider: TranscriptionProviderId;
  /** Index of the chunk this segment was transcribed from. */
  chunkIndex: number;
  timestampSource: TimestampSource;
  /** Provider confidence, only when the provider genuinely supplies one. */
  confidence: number | null;
  /** Diagnostic metadata. */
  metadata: Record<string, string | number | boolean | null>;
}

/** One deterministic ASR request window in source time. */
export interface ChunkBoundary {
  index: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  /** How many times this window was split because a provider rejected it. */
  subdivisionDepth: number;
}

/** A segment as reported by a provider, in provider-local (chunk) time. */
export interface ProviderSegment {
  text: string;
  start: number;
  end: number;
  words?: Array<{ text: string; start: number; end: number }>;
  confidence?: number | null;
  timestampSource: TimestampSource;
}

/** Round to milliseconds, the precision every transcript timing is stored at. */
export function roundTime(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
