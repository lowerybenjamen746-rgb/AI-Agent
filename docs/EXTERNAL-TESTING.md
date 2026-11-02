# External testing guide

How to try AI-AGENT independently and tell us what broke. You do not need any
access to the project that originally produced these packages.

## What to expect

Three independent packages, none published to npm:

- `media-worker` — HTTP worker, no runtime dependencies, no build step
- `medkit` — FFmpeg execution and MP4 metadata, needs an FFmpeg binary
- `transcript-utils` — timing/SRT helpers, no runtime dependencies

Version `0.1.0`: the API may change before `1.0.0`.

## 1. Get the code

```bash
git clone https://github.com/lowerybenjamen746-rgb/AI-AGENT.git
cd AI-AGENT
node --version      # must be 20.11 or newer
```

## 2. Build and test

```bash
npm ci
npm run build
npm test
npm run lint
```

`npm test` runs 71 package tests plus the example smoke tests. FFmpeg
integration tests are skipped unless a binary is available:

```bash
FFMPEG_PATH=/usr/bin/ffmpeg npm test
```

Record the exact numbers you see. If a test is skipped, that is not a pass.

## 3. Run the examples

```bash
node examples/01-media-worker/run.mjs
FFMPEG_PATH=/usr/bin/ffmpeg node examples/02-medkit/run.mjs
node examples/03-transcript-utils/run.mjs
```

Each prints the real result of real calls. An example exiting non-zero is a bug
worth reporting.

## 4. Try it as a dependency

The most useful test is installing a package into an unrelated project:

```bash
mkdir /tmp/ai-agent-consumer && cd /tmp/ai-agent-consumer
npm init -y
npm install /path/to/AI-AGENT/packages/medkit
node --input-type=module -e "
import { detectFFmpeg, defaultTextAssetRoot } from '@ai-agent/medkit';
console.log(defaultTextAssetRoot());
console.log(detectFFmpeg({ checkTextRender: true }));
"
```

This checks the thing packaging most often breaks: whether assets and binaries
resolve when the package is not the current directory.

## 5. Report what you found

Open an issue using the **Installation problem or usability feedback** template.
It asks for the details that usually explain a failure:

- operating system
- Node.js version
- package tested
- installation command
- expected vs actual behaviour
- a minimal reproduction
- error output **with secrets removed**

Please do not include tokens, credentials or anything private. Security problems
go through [SECURITY.md](../SECURITY.md) instead of a public issue.

## Questions worth answering in your report

- Did the README answer your question, or did you have to read the source?
- Was anything in the docs wrong, or true but misleading?
- Did any error message tell you what to do next?
- Did installation work first time on your platform?

Negative answers are the useful ones. There is no expectation that this works
perfectly yet.
