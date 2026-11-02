# @ai-agent/medkit

FFmpeg execution backend and container metadata helpers for Node media
pipelines.

## Install

> This package is **not published to npm**. `npm install @ai-agent/medkit`
> does not work yet. Install it from source.

```bash
git clone https://github.com/lowerybenjamen746-rgb/AI-AGENT.git
cd AI-AGENT/packages/medkit
npm ci
npm run build               # TypeScript -> dist/
```

Or add it to another project by path:

```bash
npm install /path/to/AI-AGENT/packages/medkit
```

You must provide an FFmpeg binary. This package does **not** ship one.
It looks for `FFMPEG_PATH`, then a bundled `node_modules/ffmpeg-static/ffmpeg`,
then `ffmpeg` on `PATH`, then common install locations.

## Use

```ts
import { detectFFmpeg, probeVideoFileByPath, runFFmpeg } from '@ai-agent/medkit';

const capability = detectFFmpeg();
if (!capability.available) throw new Error(capability.reason);

const code = await runFFmpeg({
  binary: capability.binary!,
  args: ['-i', 'in.mp4', '-c:v', 'libx264', 'out.mp4'],
  workingDirectory: '/tmp/job-1',
  timeoutMs: 120_000,
  onProgress: ({ progress, time }) => console.log(progress, time),
});
```

```ts
const info = await probeVideoFileByPath('/tmp/job-1/in.mp4');
console.log(info.video?.durationSeconds, info.video?.width, info.video?.height);
```

## What it does

- **Discovery and capability proof.** The first real FFmpeg build found
  decides the outcome. If it lacks a required filter or encoder the result is
  `available: false` naming the gap — it never swaps in a different binary.
- **Read-only bundle support.** A binary shipped without its execute bit is
  copied to `$TMPDIR` with mode 0755 and reused.
- **Bounded execution.** Wall-clock timeout, parsed progress only from real
  `time=` output after the input duration is known, and single-settle
  cancellation.
- **Container probe.** MP4 `moov`/`trak`/sample-table walk with no decoding.
  Anything unreadable is `null`, never `0`.

## Requirements on the FFmpeg build

By default the required filters/encoders for a typical H.264 + subtitles chain
are checked (`DEFAULT_REQUIRED_FILTERS`, `libx264`, `aac`). If your chain is
different, pass `requiredFilters` / `requiredEncoders` to `detectFFmpeg()`.

Text rendering (`drawtext`) needs a font. The font and a private fontconfig
file ship in the package's own `assets/ffmpeg/`, resolved relative to the
installed module — not to your working directory — so
`detectFFmpeg({ checkTextRender: true })` works from any project. If you vendor
or relocate those assets, pass `stageTextAssets({ cwd })` pointing at a
directory that contains `assets/ffmpeg`.

The staged font directory is created **once per process** and reused; the
first successful staging wins for the life of that process. A later call
validates its own root (so a wrong `cwd` throws) but does not re-stage
different assets — start a new process if you need to switch them.

Note that builds such as the common static `--enable-gpl --enable-libx264`
build are GPLv3; that obligation is yours to satisfy for the binary you use.

## Test

```bash
npm run build
npm test                          # unit tests; FFmpeg tests skip without a binary
FFMPEG_PATH=/usr/bin/ffmpeg npm test   # full run
```

## License

GPL-3.0-or-later. The bundled `drawtext.ttf` is DejaVu (Bitstream Vera licence,
included under `assets/ffmpeg/fonts/`). See [../../docs/LICENSING.md](../../docs/LICENSING.md).
