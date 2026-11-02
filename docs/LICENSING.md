# Licensing

This repository is deliberately **mixed-licensed**. The split follows the actual
dependency graph and the FFmpeg obligations, not convenience.

| Path | License |
|---|---|
| `packages/media-worker` | **GPL-3.0-or-later** |
| `packages/medkit` | **GPL-3.0-or-later** |
| `packages/transcript-utils` | **MIT** |
| documentation, CI config, repository files | **GPL-3.0-or-later** (see note) |

Full texts: [LICENSE](../LICENSE) (GPL-3.0), [LICENSES/GPL-3.0-or-later.txt](../LICENSES/GPL-3.0-or-later.txt),
[LICENSES/MIT.txt](../LICENSES/MIT.txt), [LICENSES/Bitstream-Vera-DejaVu-font.txt](../LICENSES/Bitstream-Vera-DejaVu-font.txt).

## Why medkit and the worker are GPL

`medkit` is an execution backend for FFmpeg and is designed to drive a build
with `--enable-gpl` (including `libx264`/`libx265`). The binary it was developed
against reports `--enable-gpl --enable-version3`, which makes that FFmpeg build
GPLv3. The npm package commonly used to supply it, `ffmpeg-static@5.2.0`,
declares `GPL-3.0-or-later`.

Because the worker is what actually invokes that renderer in the intended
deployment, it carries the same license. This repository **does not distribute
an FFmpeg binary** — you install or provide your own build, and its license
obligations are yours to satisfy for that build.

If you ship an FFmpeg build configured without GPL-only components, that does
not retroactively change the license of this source code; it remains
GPL-3.0-or-later.

## Why transcript-utils is MIT

It has no FFmpeg dependency and no third-party runtime dependency. It is pure
TypeScript over plain data shapes. Its dependency graph is empty, so MIT is
accurate rather than merely convenient.

## Third-party notices

| Component | License | Distributed here? |
|---|---|---|
| Node.js built-in modules | MIT (Node.js); used, not distributed | no |
| TypeScript compiler (`devDependency`) | Apache-2.0 | no |
| FFmpeg | GPL-3.0 (as built with `--enable-gpl`) | **no** — install separately |
| `drawtext.ttf` in `packages/medkit/assets/ffmpeg/fonts/` | Bitstream Vera / DejaVu (see `LICENSES/Bitstream-Vera-DejaVu-font.txt`) | yes, notice required and included |

If you add a dependency to `transcript-utils`, check that it is MIT-compatible
before merging. If you add one to `medkit` or the worker, it must be
GPL-3.0-or-later-compatible.

## Copyright

`Copyright (c) 2026 AI-AGENT contributors`. Code in this repository derived from
an earlier private application has been rewritten or adapted for this package;
the adaptation is documented in the source files where it is not obvious.
