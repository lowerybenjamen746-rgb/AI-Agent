/**
 * Container-level video probe.
 *
 * Reads the metadata an MP4 (ISO base media file format) already carries - track
 * headers, sample tables and per-sample payload sizes - out of a buffer that has
 * ALREADY been downloaded. No frame decoding, no FFmpeg pass, no new dependency
 * and no second download: the probe only walks box headers and the sample
 * tables, so a 30 minute 1080p source costs a few hundred kilobytes of reads.
 *
 * What it deliberately does NOT do:
 *   - decode video frames (black-frame, scene-cut and face detection all need a
 *     decoder; use `ffmpeg-runner` for that);
 *   - decode audio (loudness, silence and clipping need PCM samples);
 *   - parse Matroska/WebM beyond container identification.
 *
 * Everything the probe cannot read is reported as `null`, and callers must treat
 * `null` as unmeasured rather than as a zero.
 */

export type VideoContainer = 'mp4' | 'webm' | 'unknown';

/** Maximum number of samples expanded into the per-frame timeline. */
export const MAX_TIMELINE_FRAMES = 300_000;
/** Maximum number of boxes visited while walking the file. */
export const MAX_BOXES_SCANNED = 4_096;

export interface VideoTrackInfo {
  /** Coded width in pixels (track header, falling back to the sample entry). */
  width: number;
  height: number;
  /** Average frames per second over the video track's own duration. */
  frameRate: number | null;
  durationSeconds: number | null;
  frameCount: number | null;
  /** Total video payload bits per pixel per second (compression density). */
  bitsPerPixelPerSecond: number | null;
}

export interface AudioTrackInfo {
  codec: string | null;
  sampleRate: number | null;
  channels: number | null;
  durationSeconds: number | null;
  /**
   * Samples in the audio sample table; `null` when the table could not be read.
   * The probe reports `audio: null` (no `soun` track at all) when the file
   * declares no audio track, so an audio track object always means "declared".
   */
  sampleCount: number | null;
  /** Measured average encoded audio bitrate in kbit/s (diagnostic only). */
  bitrateKbps: number | null;
}

/**
 * Per-frame view of the video sample table.
 *
 * `frameSizes` are the compressed payload sizes in bytes and `frameEndSeconds`
 * the decode end time of each sample, so a time window can be mapped back to the
 * frames that belong to it without decoding anything. `syncFrameFlags` marks
 * keyframes (sample table `stss`).
 */
export interface VideoFrameTimeline {
  frameCount: number;
  durationSeconds: number;
  frameEndSeconds: Float64Array;
  frameSizes: Uint32Array;
  syncFrameFlags: Uint8Array;
  /** Mean video payload per second over the whole track. */
  bytesPerSecond: number;
  /** Median payload of a non-keyframe (the moving-picture reference size). */
  medianInterFrameBytes: number;
}

export interface VideoProbeResult {
  container: VideoContainer;
  sizeBytes: number;
  video: VideoTrackInfo | null;
  audio: AudioTrackInfo | null;
  timeline: VideoFrameTimeline | null;
  /** Human-readable diagnostics; never used for ranking. */
  notes: string[];
}

export interface FrameWindowStats {
  frameCount: number;
  interFrameCount: number;
  syncFrameCount: number;
  windowSeconds: number;
  bytesPerSecond: number;
  /** Window payload rate divided by the whole-track payload rate. */
  relativeActivity: number;
  /** Non-keyframes below the static-frame fraction of the track median. */
  staticFrames: number;
  staticFrameRatio: number;
}

interface Mp4Box {
  type: string;
  /** Payload start, immediately after the 8 or 16 byte box header. */
  start: number;
  /** Payload end (exclusive). */
  end: number;
}

interface BoxScanState {
  visited: number;
}

const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3] as const;

function asBuffer(input: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function detectContainer(buffer: Buffer): VideoContainer {
  if (buffer.byteLength >= 12 && buffer.toString('latin1', 4, 8) === 'ftyp') return 'mp4';
  if (
    buffer.byteLength >= 4 &&
    WEBM_MAGIC.every((byte, index) => buffer[index] === byte)
  ) {
    return 'webm';
  }
  return 'unknown';
}

/** Read the box header at `offset`, or null when it is malformed/truncated. */
function readBoxHeader(
  buffer: Buffer,
  offset: number,
  limit: number,
): { type: string; payloadStart: number; end: number } | null {
  if (offset + 8 > limit) return null;
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1) {
    if (offset + 16 > limit) return null;
    const large = Number(buffer.readBigUInt64BE(offset + 8));
    if (!Number.isSafeInteger(large) || large < 16) return null;
    size = large;
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset;
  }

  if (size < headerSize) return null;
  return {
    type,
    payloadStart: offset + headerSize,
    end: Math.min(limit, offset + size),
  };
}

/** Direct children of one parent box, in file order. */
function childBoxes(
  buffer: Buffer,
  parentStart: number,
  parentEnd: number,
  state: BoxScanState,
): Mp4Box[] {
  const boxes: Mp4Box[] = [];
  let offset = parentStart;
  while (offset + 8 <= parentEnd) {
    if (state.visited >= MAX_BOXES_SCANNED) break;
    const header = readBoxHeader(buffer, offset, parentEnd);
    if (!header) break;
    state.visited += 1;
    boxes.push({ type: header.type, start: header.payloadStart, end: header.end });
    if (header.end <= offset) break;
    offset = header.end;
  }
  return boxes;
}

function readUint16(buffer: Buffer, offset: number, limit: number): number | null {
  if (offset + 2 > limit) return null;
  return buffer.readUInt16BE(offset);
}

function readUint32(buffer: Buffer, offset: number, limit: number): number | null {
  if (offset + 4 > limit) return null;
  return buffer.readUInt32BE(offset);
}

/**
 * `mvhd` / `mdhd` share their layout: version+flags, then timescale and
 * duration, with 64-bit fields in version 1.
 */
function readHeaderTimes(buffer: Buffer, box: Mp4Box | null): { timescale: number; duration: number } | null {
  if (!box || box.start + 4 > box.end) return null;
  const version = buffer.readUInt8(box.start);
  const timescaleAt = version === 1 ? box.start + 20 : box.start + 12;
  const durationAt = version === 1 ? box.start + 24 : box.start + 16;
  const timescale = readUint32(buffer, timescaleAt, box.end);
  if (!timescale || timescale <= 0) return null;

  let duration: number | null = null;
  if (version === 1) {
    if (durationAt + 8 <= box.end) duration = Number(buffer.readBigUInt64BE(durationAt));
  } else {
    duration = readUint32(buffer, durationAt, box.end);
  }
  if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
  return { timescale, duration };
}

/** Handler type of a media box (`vide`, `soun`, ...). */
function readHandlerType(buffer: Buffer, hdlr: Mp4Box | null): string | null {
  if (!hdlr || hdlr.start + 12 > hdlr.end) return null;
  const handler = buffer.toString('latin1', hdlr.start + 8, hdlr.start + 12).trim();
  return handler.length > 0 ? handler : null;
}

/**
 * Coded dimensions from `tkhd` (16.16 fixed point). The track header can be zero
 * in files that only fill in the sample entry, so callers fall back to it.
 */
function readTrackDimensions(buffer: Buffer, tkhd: Mp4Box | null): { width: number; height: number } | null {
  if (!tkhd || tkhd.start + 8 > tkhd.end) return null;
  const version = buffer.readUInt8(tkhd.start);
  const widthAt = version === 1 ? tkhd.start + 88 : tkhd.start + 76;
  const rawWidth = readUint32(buffer, widthAt, tkhd.end);
  const rawHeight = readUint32(buffer, widthAt + 4, tkhd.end);
  if (rawWidth === null || rawHeight === null) return null;
  const width = Math.round(rawWidth / 65536);
  const height = Math.round(rawHeight / 65536);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

interface SampleEntryInfo {
  codec: string | null;
  width: number | null;
  height: number | null;
  channels: number | null;
  sampleRate: number | null;
}

/**
 * First sample entry of `stsd`: codec fourcc plus the fields that differ between
 * visual (width/height at 24/26) and audio (channels at 16, sample rate 16.16 at
 * 24) sample entries.
 */
function readSampleEntry(buffer: Buffer, stsd: Mp4Box | null): SampleEntryInfo {
  const empty: SampleEntryInfo = { codec: null, width: null, height: null, channels: null, sampleRate: null };
  if (!stsd || stsd.start + 16 > stsd.end) return empty;

  const entrySize = readUint32(buffer, stsd.start + 8, stsd.end);
  if (entrySize === null || entrySize < 8) return empty;
  const codec = buffer.toString('latin1', stsd.start + 12, stsd.start + 16).trim();
  const payload = stsd.start + 16;
  const payloadEnd = Math.min(stsd.end, stsd.start + 8 + entrySize);

  const width = readUint16(buffer, payload + 24, payloadEnd);
  const height = readUint16(buffer, payload + 26, payloadEnd);
  const channels = readUint16(buffer, payload + 16, payloadEnd);
  const rawRate = readUint32(buffer, payload + 24, payloadEnd);

  return {
    codec: codec.length > 0 ? codec : null,
    width: width !== null && width > 0 ? width : null,
    height: height !== null && height > 0 ? height : null,
    channels: channels !== null && channels > 0 ? channels : null,
    sampleRate: rawRate !== null && rawRate > 0 ? Math.round(rawRate / 65536) : null,
  };
}
/** Per-sample payload sizes from `stsz` or `stz2` (capped at `limit` samples). */
function readSampleSizes(
  buffer: Buffer,
  stsz: Mp4Box | null,
  stz2: Mp4Box | null,
  limit: number,
): Uint32Array | null {
  if (stsz && stsz.start + 12 <= stsz.end) {
    const uniformSize = readUint32(buffer, stsz.start + 4, stsz.end) ?? 0;
    const sampleCount = readUint32(buffer, stsz.start + 8, stsz.end) ?? 0;
    if (sampleCount <= 0 || sampleCount > limit) return null;
    const sizes = new Uint32Array(sampleCount);
    if (uniformSize > 0) {
      sizes.fill(uniformSize);
      return sizes;
    }
    const tableStart = stsz.start + 12;
    for (let index = 0; index < sampleCount; index += 1) {
      const size = readUint32(buffer, tableStart + index * 4, stsz.end);
      if (size === null) return null;
      sizes[index] = size;
    }
    return sizes;
  }

  if (!stz2 || stz2.start + 12 > stz2.end) return null;
  const fieldSize = buffer.readUInt8(stz2.start + 7);
  const sampleCount = readUint32(buffer, stz2.start + 8, stz2.end) ?? 0;
  if (sampleCount <= 0 || sampleCount > limit) return null;
  const sizes = new Uint32Array(sampleCount);
  const tableStart = stz2.start + 12;

  if (fieldSize === 4) {
    for (let index = 0; index < sampleCount; index += 1) {
      const byte = buffer.readUInt8(tableStart + Math.floor(index / 2));
      sizes[index] = index % 2 === 0 ? byte >> 4 : byte & 0x0f;
    }
    return sizes;
  }
  if (fieldSize === 8) {
    if (tableStart + sampleCount > stz2.end) return null;
    for (let index = 0; index < sampleCount; index += 1) {
      sizes[index] = buffer.readUInt8(tableStart + index);
    }
    return sizes;
  }
  if (fieldSize === 16) {
    for (let index = 0; index < sampleCount; index += 1) {
      const value = readUint16(buffer, tableStart + index * 2, stz2.end);
      if (value === null) return null;
      sizes[index] = value;
    }
    return sizes;
  }
  return null;
}

/**
 * Per-sample durations (in media timescale units) expanded from the `stts`
 * run-length table, so a window can be located by time.
 */
function readSampleDurations(
  buffer: Buffer,
  stts: Mp4Box | null,
  frameCount: number,
): Float64Array | null {
  if (!stts || stts.start + 8 > stts.end) return null;
  const entryCount = readUint32(buffer, stts.start + 4, stts.end) ?? 0;
  if (entryCount <= 0 || entryCount > MAX_BOXES_SCANNED) return null;

  const durations = new Float64Array(frameCount);
  let offset = 0;
  for (let entry = 0; entry < entryCount && offset < frameCount; entry += 1) {
    const at = stts.start + 8 + entry * 8;
    const count = readUint32(buffer, at, stts.end);
    const delta = readUint32(buffer, at + 4, stts.end);
    if (count === null || delta === null) break;
    for (let index = 0; index < count && offset < frameCount; index += 1) {
      durations[offset] = delta;
      offset += 1;
    }
  }
  if (offset === 0) return null;
  return durations;
}

/**
 * Keyframe flags from `stss` (sample numbers are 1-based). A file without an
 * `stss` table declares every sample as a sync sample, which is what the flags
 * then report.
 */
function readSyncFlags(buffer: Buffer, stss: Mp4Box | null, frameCount: number): Uint8Array {
  const flags = new Uint8Array(frameCount);
  if (!stss || stss.start + 8 > stss.end) {
    flags.fill(1);
    return flags;
  }
  const entryCount = readUint32(buffer, stss.start + 4, stss.end) ?? 0;
  const capped = Math.min(entryCount, frameCount);
  for (let entry = 0; entry < capped; entry += 1) {
    const sampleNumber = readUint32(buffer, stss.start + 8 + entry * 4, stss.end);
    if (sampleNumber === null) break;
    const index = sampleNumber - 1;
    if (index >= 0 && index < frameCount) flags[index] = 1;
  }
  return flags;
}


interface ParsedTrack {
  handler: string | null;
  tkhd: Mp4Box | null;
  stsd: Mp4Box | null;
  stsz: Mp4Box | null;
  stz2: Mp4Box | null;
  stts: Mp4Box | null;
  stss: Mp4Box | null;
  timescale: number | null;
  durationSeconds: number | null;
}

function parseTrack(buffer: Buffer, trak: Mp4Box, state: BoxScanState): ParsedTrack {
  const children = childBoxes(buffer, trak.start, trak.end, state);
  const tkhd = children.find((box) => box.type === 'tkhd') ?? null;
  const mdia = children.find((box) => box.type === 'mdia') ?? null;
  const mdiaChildren = mdia ? childBoxes(buffer, mdia.start, mdia.end, state) : [];
  const mdhd = mdiaChildren.find((box) => box.type === 'mdhd') ?? null;
  const hdlr = mdiaChildren.find((box) => box.type === 'hdlr') ?? null;
  const minf = mdiaChildren.find((box) => box.type === 'minf') ?? null;
  const stbl = minf
    ? childBoxes(buffer, minf.start, minf.end, state).find((box) => box.type === 'stbl') ?? null
    : null;
  const stblChildren = stbl ? childBoxes(buffer, stbl.start, stbl.end, state) : [];
  const times = readHeaderTimes(buffer, mdhd);

  return {
    handler: readHandlerType(buffer, hdlr),
    tkhd,
    stsd: stblChildren.find((box) => box.type === 'stsd') ?? null,
    stsz: stblChildren.find((box) => box.type === 'stsz') ?? null,
    stz2: stblChildren.find((box) => box.type === 'stz2') ?? null,
    stts: stblChildren.find((box) => box.type === 'stts') ?? null,
    stss: stblChildren.find((box) => box.type === 'stss') ?? null,
    timescale: times?.timescale ?? null,
    durationSeconds: times ? times.duration / times.timescale : null,
  };
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

/** Turn the video sample tables into a per-frame timeline; null when unusable. */
function buildTimeline(input: {
  sizes: Uint32Array;
  durations: Float64Array;
  syncFlags: Uint8Array;
  timescale: number;
}): VideoFrameTimeline | null {
  const { sizes, durations, syncFlags, timescale } = input;
  const frameCount = sizes.length;
  if (frameCount === 0 || timescale <= 0) return null;

  const secondsPerUnit = 1 / timescale;
  const frameEndSeconds = new Float64Array(frameCount);
  let elapsed = 0;
  for (let index = 0; index < frameCount; index += 1) {
    elapsed += (durations[index] ?? 0) * secondsPerUnit;
    frameEndSeconds[index] = elapsed;
  }
  if (!Number.isFinite(elapsed) || elapsed <= 0) return null;

  const interFrameSizes: number[] = [];
  let totalBytes = 0;
  for (let index = 0; index < frameCount; index += 1) {
    const size = sizes[index] ?? 0;
    totalBytes += size;
    if ((syncFlags[index] ?? 0) === 0) interFrameSizes.push(size);
  }

  const medianInterFrameBytes = medianOf(
    interFrameSizes.length > 0 ? interFrameSizes : Array.from(sizes),
  );
  if (medianInterFrameBytes <= 0) return null;

  return {
    frameCount,
    durationSeconds: elapsed,
    frameEndSeconds,
    frameSizes: sizes,
    syncFrameFlags: syncFlags,
    bytesPerSecond: totalBytes / elapsed,
    medianInterFrameBytes,
  };
}
/** Payload share of the track median below which a frame carries no new detail. */
export const DEFAULT_STATIC_FRAME_FRACTION = 0.15;

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** First index whose frame end time is strictly after `seconds`. */
function lowerBound(times: Float64Array, seconds: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? 0) <= seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Probe an already-downloaded video buffer.
 *
 * Never throws on malformed input: anything unreadable is reported as `null`
 * together with a note, so callers can treat a missing field as unmeasured.
 */
export function probeVideoContainer(input: Buffer | Uint8Array): VideoProbeResult {
  const buffer = asBuffer(input);
  const notes: string[] = [];
  const container = buffer.byteLength > 0 ? detectContainer(buffer) : 'unknown';
  const result: VideoProbeResult = {
    container,
    sizeBytes: buffer.byteLength,
    video: null,
    audio: null,
    timeline: null,
    notes,
  };

  if (buffer.byteLength === 0) {
    notes.push('Empty buffer: nothing to probe.');
    return result;
  }

  if (container !== 'mp4') {
    notes.push(
      container === 'webm'
        ? 'WebM/Matroska probing is not implemented: media signals stay unmeasured for this source.'
        : 'Container is neither MP4 nor WebM: media signals stay unmeasured for this source.',
    );
    return result;
  }

  try {
    const state: BoxScanState = { visited: 0 };
    const top = childBoxes(buffer, 0, buffer.byteLength, state);
    const moov = top.find((box) => box.type === 'moov') ?? null;
    if (!moov) {
      notes.push('No moov box in probed window (non-fast-start or fragmented MP4): track metadata unavailable from head-only probe.');
      return result;
    }


    const moovChildren = childBoxes(buffer, moov.start, moov.end, state);
    const mvhd = moovChildren.find((box) => box.type === 'mvhd') ?? null;
    const movieTimes = readHeaderTimes(buffer, mvhd);
    const traks = moovChildren.filter((box) => box.type === 'trak');
    if (traks.length === 0) notes.push('No track found in moov.');

    const tracks = traks.map((trak) => parseTrack(buffer, trak, state));
    const videoTrack = tracks.find((track) => track.handler === 'vide') ?? null;
    const audioTrack = tracks.find((track) => track.handler === 'soun') ?? null;

    let timeline: VideoFrameTimeline | null = null;

    if (videoTrack) {
      const entry = readSampleEntry(buffer, videoTrack.stsd);
      const dimensions = readTrackDimensions(buffer, videoTrack.tkhd);
      const width = entry.width ?? dimensions?.width ?? 0;
      const height = entry.height ?? dimensions?.height ?? 0;
      const sizes = readSampleSizes(buffer, videoTrack.stsz, videoTrack.stz2, MAX_TIMELINE_FRAMES);
      const durations = sizes ? readSampleDurations(buffer, videoTrack.stts, sizes.length) : null;

      if (sizes && durations && videoTrack.timescale) {
        const syncFlags = readSyncFlags(buffer, videoTrack.stss, sizes.length);
        timeline = buildTimeline({
          sizes,
          durations,
          syncFlags,
          timescale: videoTrack.timescale,
        });
      }

      const frameCount = sizes?.length ?? null;
      const durationSeconds =
        videoTrack.durationSeconds ??
        timeline?.durationSeconds ??
        (movieTimes ? movieTimes.duration / movieTimes.timescale : null);
      let totalVideoBytes: number | null = null;
      if (sizes) {
        totalVideoBytes = 0;
        for (let index = 0; index < sizes.length; index += 1) totalVideoBytes += sizes[index] ?? 0;
      }

      if (width > 0 && height > 0) {
        result.video = {
          width,
          height,
          frameRate:
            frameCount !== null && durationSeconds && durationSeconds > 0
              ? roundTo(frameCount / durationSeconds, 2)
              : null,
          durationSeconds: durationSeconds !== null ? roundTo(durationSeconds, 2) : null,
          frameCount,
          bitsPerPixelPerSecond:
            totalVideoBytes !== null && durationSeconds && durationSeconds > 0
              ? roundTo((totalVideoBytes * 8) / durationSeconds / (width * height), 4)
              : null,
        };
      } else {
        notes.push('Video track dimensions could not be read.');
      }
    }

    if (audioTrack) {
      const entry = readSampleEntry(buffer, audioTrack.stsd);
      const sizes = readSampleSizes(buffer, audioTrack.stsz, audioTrack.stz2, MAX_TIMELINE_FRAMES);
      let totalAudioBytes: number | null = null;
      if (sizes) {
        totalAudioBytes = 0;
        for (let index = 0; index < sizes.length; index += 1) totalAudioBytes += sizes[index] ?? 0;
      }
      const durationSeconds = audioTrack.durationSeconds;
      result.audio = {
        codec: entry.codec,
        sampleRate: entry.sampleRate,
        channels: entry.channels,
        durationSeconds: durationSeconds !== null ? roundTo(durationSeconds, 2) : null,
        sampleCount: sizes?.length ?? null,
        bitrateKbps:
          totalAudioBytes !== null && durationSeconds && durationSeconds > 0
            ? roundTo((totalAudioBytes * 8) / durationSeconds / 1000, 1)
            : null,
      };
    }

    result.timeline = timeline;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`Probe failed (${message}): media signals stay unmeasured.`);
    return { ...result, video: null, audio: null, timeline: null, notes };
  }
}

/**
 * Probe a staged video file by path using positional reads.
 * Never loads the entire file into memory. Scans MP4 box headers sequentially
 * via fs.open + handle.read() with a 16-byte window, skipping payloads by seeking.
 * When the moov atom is found, only its payload is read into a Buffer for parsing.
 */
export async function probeVideoFileByPath(filePath: string): Promise<VideoProbeResult | null> {
  const { open, stat } = await import('node:fs/promises');
  let fileSize: number;
  try {
    const stats = await stat(filePath);
    fileSize = stats.size;
  } catch {
    return null;
  }
  if (fileSize < 12) return null;
  const notes: string[] = [];
  const result: VideoProbeResult = {
    container: 'unknown', sizeBytes: fileSize,
    video: null, audio: null, timeline: null, notes,
  };
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(filePath, 'r');
    const headerBuf = Buffer.alloc(16);
    const { bytesRead: headRead } = await handle.read(headerBuf, 0, 12, 0);
    if (headRead < 12) return null;
    const container = detectContainer(headerBuf.subarray(0, 12));
    result.container = container;
    if (container !== 'mp4') {
      notes.push('File-path probe supports MP4 only; container is not mp4.');
      return result;
    }
    let offset = 0;
    let boxesVisited = 0;
    let moovOffset = -1;
    let moovSize = 0;
    while (offset + 8 <= fileSize && boxesVisited < MAX_BOXES_SCANNED) {
      const { bytesRead } = await handle.read(headerBuf, 0, Math.min(16, fileSize - offset), offset);
      if (bytesRead < 8) break;
      let size = headerBuf.readUInt32BE(0);
      const type = headerBuf.toString('latin1', 4, 8);
      let headerSize = 8;
      if (size === 1) {
        if (bytesRead < 16) break;
        const large = Number(headerBuf.readBigUInt64BE(8));
        if (!Number.isSafeInteger(large) || large < 16) break;
        size = large;
        headerSize = 16;
      } else if (size === 0) {
        size = fileSize - offset;
      }
      if (size < headerSize) break;
      if (type === 'moov') {
        moovOffset = offset + headerSize;
        moovSize = size - headerSize;
        break;
      }
      boxesVisited += 1;
      offset += size;
    }
    if (moovOffset < 0 || moovSize <= 0) {
      notes.push('No moov box found via file-path scan.');
      return result;
    }
    if (moovSize > 64 * 1024 * 1024) {
      notes.push('moov atom exceeds 64MB; skipping file-path probe.');
      return result;
    }
    const moovBuffer = Buffer.alloc(moovSize);
    const { bytesRead: moovRead } = await handle.read(moovBuffer, 0, moovSize, moovOffset);
    if (moovRead < moovSize) {
      notes.push('Failed to read complete moov atom from file.');
      return result;
    }
    return parseMoovBuffer(moovBuffer, result, notes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`File-path probe failed (${message}).`);
    return { ...result, video: null, audio: null, timeline: null, notes };
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
  }
}

function parseMoovBuffer(
  moovBuffer: Buffer,
  result: VideoProbeResult,
  notes: string[],
): VideoProbeResult {
  try {
    const state: BoxScanState = { visited: 0 };
    const moovChildren = childBoxes(moovBuffer, 0, moovBuffer.byteLength, state);
    const mvhd = moovChildren.find((box) => box.type === 'mvhd') ?? null;
    const movieTimes = readHeaderTimes(moovBuffer, mvhd);
    const traks = moovChildren.filter((box) => box.type === 'trak');
    if (traks.length === 0) notes.push('No track found in moov (file-path probe).');
    const tracks = traks.map((trak) => parseTrack(moovBuffer, trak, state));
    const videoTrack = tracks.find((track) => track.handler === 'vide') ?? null;
    const audioTrack = tracks.find((track) => track.handler === 'soun') ?? null;
    let timeline: VideoFrameTimeline | null = null;
    if (videoTrack) {
      const entry = readSampleEntry(moovBuffer, videoTrack.stsd);
      const dimensions = readTrackDimensions(moovBuffer, videoTrack.tkhd);
      const width = entry.width ?? dimensions?.width ?? 0;
      const height = entry.height ?? dimensions?.height ?? 0;
      const sizes = readSampleSizes(moovBuffer, videoTrack.stsz, videoTrack.stz2, MAX_TIMELINE_FRAMES);
      const durations = sizes ? readSampleDurations(moovBuffer, videoTrack.stts, sizes.length) : null;
      if (sizes && durations && videoTrack.timescale) {
        const syncFlags = readSyncFlags(moovBuffer, videoTrack.stss, sizes.length);
        timeline = buildTimeline({ sizes, durations, syncFlags, timescale: videoTrack.timescale });
      }
      const frameCount = sizes?.length ?? null;
      const durationSeconds =
        videoTrack.durationSeconds ??
        timeline?.durationSeconds ??
        (movieTimes ? movieTimes.duration / movieTimes.timescale : null);
      let totalVideoBytes: number | null = null;
      if (sizes) {
        totalVideoBytes = 0;
        for (let i = 0; i < sizes.length; i += 1) totalVideoBytes += sizes[i] ?? 0;
      }
      if (width > 0 && height > 0) {
        result.video = {
          width, height,
          frameRate: frameCount !== null && durationSeconds && durationSeconds > 0 ? roundTo(frameCount / durationSeconds, 2) : null,
          durationSeconds: durationSeconds !== null ? roundTo(durationSeconds, 2) : null,
          frameCount,
          bitsPerPixelPerSecond: totalVideoBytes !== null && durationSeconds && durationSeconds > 0 ? roundTo((totalVideoBytes * 8) / durationSeconds / (width * height), 4) : null,
        };
      } else {
        notes.push('Video track dimensions could not be read (file-path probe).');
      }
    }
    if (audioTrack) {
      const entry = readSampleEntry(moovBuffer, audioTrack.stsd);
      const sizes = readSampleSizes(moovBuffer, audioTrack.stsz, audioTrack.stz2, MAX_TIMELINE_FRAMES);
      let totalAudioBytes: number | null = null;
      if (sizes) {
        totalAudioBytes = 0;
        for (let i = 0; i < sizes.length; i += 1) totalAudioBytes += sizes[i] ?? 0;
      }
      const durationSeconds = audioTrack.durationSeconds;
      result.audio = {
        codec: entry.codec, sampleRate: entry.sampleRate, channels: entry.channels,
        durationSeconds: durationSeconds !== null ? roundTo(durationSeconds, 2) : null,
        sampleCount: sizes?.length ?? null,
        bitrateKbps: totalAudioBytes !== null && durationSeconds && durationSeconds > 0 ? roundTo((totalAudioBytes * 8) / durationSeconds / 1000, 1) : null,
      };
    }
    result.timeline = timeline;
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    notes.push(`parseMoovBuffer failed (${message}).`);
    return { ...result, video: null, audio: null, timeline: null, notes };
  }
}

/**
 * Aggregate the frames that belong to a time window.
 *
 * `relativeActivity` compares the window's compressed payload rate with the
 * whole track's, which makes the measure scale-invariant across bitrates and
 * resolutions: 1 means "as much encoded change as this source averages", 2 means
 * twice as much. `staticFrameRatio` is the share of NON-keyframes whose payload
 * is below `staticFrameFraction` of the track's median non-keyframe payload -
 * frames that carry almost no new information.
 */
export function analyzeFrameWindow(
  timeline: VideoFrameTimeline,
  startSeconds: number,
  endSeconds: number,
  options?: { staticFrameFraction?: number },
): FrameWindowStats | null {
  const from = Math.max(0, Math.min(startSeconds, endSeconds));
  const to = Math.min(timeline.durationSeconds, Math.max(startSeconds, endSeconds));
  const windowSeconds = to - from;
  if (!Number.isFinite(windowSeconds) || windowSeconds <= 0) return null;

  const firstIndex = lowerBound(timeline.frameEndSeconds, from);
  const endIndex = lowerBound(timeline.frameEndSeconds, to);
  if (endIndex <= firstIndex) return null;

  const fraction = options?.staticFrameFraction ?? DEFAULT_STATIC_FRAME_FRACTION;
  const staticThreshold = timeline.medianInterFrameBytes * fraction;
  let bytes = 0;
  let staticFrames = 0;
  let interFrames = 0;
  let syncFrames = 0;

  for (let index = firstIndex; index < endIndex; index += 1) {
    const size = timeline.frameSizes[index] ?? 0;
    bytes += size;
    if ((timeline.syncFrameFlags[index] ?? 0) === 1) {
      syncFrames += 1;
      continue;
    }
    interFrames += 1;
    if (size < staticThreshold) staticFrames += 1;
  }

  const bytesPerSecond = bytes / windowSeconds;
  return {
    frameCount: endIndex - firstIndex,
    interFrameCount: interFrames,
    syncFrameCount: syncFrames,
    windowSeconds,
    bytesPerSecond,
    relativeActivity: timeline.bytesPerSecond > 0 ? bytesPerSecond / timeline.bytesPerSecond : 0,
    staticFrames,
    staticFrameRatio: interFrames > 0 ? staticFrames / interFrames : 0,
  };
}
