import type { CanonicalSegment, CanonicalWord } from './types.js';

export type WordTimingOrigin = 'provider-native' | 'interpolated' | 'estimated';

export interface SelectedTranscriptSegment extends CanonicalSegment {
  sourceStart: number;
  sourceEnd: number;
  wordTimingOrigin: WordTimingOrigin;
}

export class MalformedTranscriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedTranscriptError';
  }
}

export function assertTranscriptTimestamps(segments: readonly CanonicalSegment[]): void {
  const valid = (start: number, end: number): boolean => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start;
  for (const segment of segments) {
    if (!valid(segment.start, segment.end)) throw new MalformedTranscriptError('Malformed transcript segment timestamps');
    const sourceStart = (segment as Partial<SelectedTranscriptSegment>).sourceStart ?? segment.start;
    const sourceEnd = (segment as Partial<SelectedTranscriptSegment>).sourceEnd ?? segment.end;
    let previousStart = sourceStart;
    for (const word of segment.words ?? []) {
      if (!valid(word.start, word.end) || word.start < sourceStart || word.end > sourceEnd || word.start < previousStart) {
        throw new MalformedTranscriptError('Malformed transcript word timestamps');
      }
      previousStart = word.start;
    }
  }
}

export function transcriptSegmentWords(segment: CanonicalSegment): { words: CanonicalWord[]; origin: WordTimingOrigin } {
  if (segment.words?.length) return { words: segment.words, origin: (segment as Partial<SelectedTranscriptSegment>).wordTimingOrigin ?? (segment.timestampSource === 'estimated' ? 'estimated' : 'provider-native') };
  const tokens = segment.text.trim().split(/\s+/).filter(Boolean);
  const span = (segment.end - segment.start) / tokens.length;
  return {
    words: tokens.map((text, index) => ({ text, start: segment.start + index * span, end: index === tokens.length - 1 ? segment.end : segment.start + (index + 1) * span })),
    origin: segment.timestampSource === 'estimated' ? 'estimated' : 'interpolated',
  };
}

export function selectTranscriptSegments(
  segments: readonly CanonicalSegment[],
  range: { startSeconds: number; endSeconds: number },
): SelectedTranscriptSegment[] {
  if (!Number.isFinite(range.startSeconds) || !Number.isFinite(range.endSeconds) || range.startSeconds < 0 || range.endSeconds <= range.startSeconds) return [];
  assertTranscriptTimestamps(segments);
  const selected: SelectedTranscriptSegment[] = [];
  for (const segment of segments) {
    if (segment.end <= range.startSeconds || segment.start >= range.endSeconds) continue;
    const { words, origin } = transcriptSegmentWords(segment);
    const included = words.filter(word => word.text.trim() && word.end > range.startSeconds && word.start < range.endSeconds);
    if (!included.length) continue;
    selected.push({
      ...segment,
      text: included.map(word => word.text.trim()).join(' '),
      start: Math.max(range.startSeconds, included[0].start),
      end: Math.min(range.endSeconds, Math.max(...included.map(word => word.end))),
      words: included.map(word => ({ ...word })),
      sourceStart: (segment as Partial<SelectedTranscriptSegment>).sourceStart ?? segment.start,
      sourceEnd: (segment as Partial<SelectedTranscriptSegment>).sourceEnd ?? segment.end,
      wordTimingOrigin: origin,
      metadata: { ...segment.metadata },
    });
  }
  return selected.sort((a, b) => a.start - b.start || a.end - b.end || a.chunkIndex - b.chunkIndex);
}
