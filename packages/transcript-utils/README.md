# @ai-agent/transcript-utils

Provider-agnostic transcript timing utilities.

> This package is **not published to npm**. `npm install @ai-agent/transcript-utils`
> does not work yet. Install it from source.

```bash
git clone https://github.com/lowerybenjamen746-rgb/AI-AGENT.git
cd AI-AGENT/packages/transcript-utils
npm ci
npm run build               # TypeScript -> dist/
```

Or add it to another project by path:

```bash
npm install /path/to/AI-AGENT/packages/transcript-utils
```

## What it solves

Timestamps from an ASR provider are relative to the audio window it was given,
not to the source. Nudging them by hand is where drifting subtitles come from.
These helpers make the conversion explicit and refuse to guess silently.

```ts
import {
  absoluteSegments,
  canonicalTranscriptToSrt,
  selectTranscriptSegments,
} from '@ai-agent/transcript-utils';

// 1. Map every provider window onto absolute source seconds (offset applied once).
const segments = absoluteSegments(providerSegments, {
  chunk: { index: 2, startSeconds: 120, endSeconds: 180, durationSeconds: 60, subdivisionDepth: 0 },
  provider: 'whisper',
});

// 2. Keep only the speech of the clip you are rendering, clamped to its edges.
//    The example segment is 120-122s in source time, so the window must
//    overlap it or nothing is selected.
const selected = selectTranscriptSegments(segments, { startSeconds: 120, endSeconds: 126 });

// 3. Emit clip-relative SRT (empty string when the window holds no speech).
const srt = canonicalTranscriptToSrt({ segments, startSeconds: 120, endSeconds: 126 });
```

Re-timing a subtitle file after a duration-changing edit:

```ts
import { scaleSrtTimestamps } from '@ai-agent/transcript-utils/srt';
const retimed = scaleSrtTimestamps(srt, 1.25);
```

## Guarantees

- Measured timings are preserved verbatim; only timings the provider did not
  supply are derived, and they are marked `timestampSource: 'estimated'`.
- Malformed transcripts (end before start, words outside their segment) throw
  `MalformedTranscriptError` instead of producing wrong subtitles.
- Disordered word timings are repaired; a clean timeline is returned unchanged.
- An empty cue set serialises to `''`, not to an empty subtitle file.

## Test

```bash
npm test
```

## License

MIT. This package has no FFmpeg dependency and no runtime dependencies.
