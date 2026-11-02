export interface TimelineWord {
  text: string;
  start: number;
  end: number;
}

/**
 * Order word timings inside one segment without changing the segment's text.
 *
 * Whisper word timings are not guaranteed ordered once rounded to milliseconds:
 * inside a segment a word can start before the word that precedes it, and a
 * short word can collapse to a zero-length span. Preserved verbatim they make
 * timestamp validation reject the whole transcript.
 *
 * Words are ordered by their reported start (stable, so equal starts keep
 * provider order) and placed in sequence inside the segment: each word starts
 * where the previous one ended, only moving forward. The last word is clamped to
 * the segment end and a word that still cannot carry a positive span is dropped
 * (only its timing is lost, never the segment's text). The result is ordered,
 * strictly positive and inside the segment. When the input already satisfies
 * those rules the very same word objects are returned, so a clean transcript is
 * never rewritten.
 */
export function normalizeSegmentTimeline<T extends TimelineWord>(
  words: readonly T[],
  segment: { start: number; end: number }
): T[] {
  if (words.length === 0) return [...words];
  let ordered = true;
  let previousStart = segment.start;
  for (const word of words) {
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.start < segment.start ||
        word.end > segment.end || word.start < previousStart || word.end <= previousStart || word.end <= word.start) {
      ordered = false;
      break;
    }
    previousStart = word.start;
  }
  if (ordered) return [...words];

  const sorted = words
    .map((word, index) => ({ word, index }))
    .sort((a, b) => a.word.start - b.word.start || a.index - b.index)
    .map(entry => entry.word);

  const normalized: T[] = [];
  let cursor = segment.start;
  for (const word of sorted) {
    const start = Math.max(word.start, cursor, segment.start);
    const end = Math.min(word.end, segment.end);
    if (!(end > start)) continue;
    normalized.push(start === word.start && end === word.end ? word : { ...word, start, end });
    cursor = end;
  }
  return normalized;
}
