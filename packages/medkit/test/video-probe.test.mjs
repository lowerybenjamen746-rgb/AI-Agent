import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { probeVideoContainer, probeVideoFileByPath } from '../dist/video-probe.js';

function box(type, ...payloads) {
  const body = Buffer.concat(payloads);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'ascii');
  return Buffer.concat([header, body]);
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

function mvhd(timescale, duration) {
  const body = Buffer.alloc(100);
  body.writeUInt8(0, 0);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box('mvhd', body);
}

function mdhd(timescale, duration) {
  const body = Buffer.alloc(24);
  body.writeUInt8(0, 0);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box('mdhd', body);
}

function tkhd(width, height) {
  const body = Buffer.alloc(84);
  body.writeUInt8(0, 0);
  body.writeUInt32BE(width << 16, 76);
  body.writeUInt32BE(height << 16, 80);
  return box('tkhd', body);
}

function hdlr(handler) {
  const body = Buffer.alloc(24);
  body.write(handler, 8, 'ascii');
  return box('hdlr', body);
}

function videoTrak({ width = 1080, height = 1920 } = {}) {
  return box('trak', tkhd(width, height), box('mdia', mdhd(1000, 5600), hdlr('vide')));
}

function minimalMp4(trak = videoTrak()) {
  return Buffer.concat([box('ftyp', Buffer.from('isom', 'ascii'), u32(512)), box('moov', mvhd(1000, 5600), trak), box('mdat', Buffer.alloc(16))]);
}

test('a minimal MP4 reports its container and movie duration', () => {
  const result = probeVideoContainer(minimalMp4());
  assert.equal(result.container, 'mp4');
  assert.ok(result.sizeBytes > 0);
  assert.ok(result.video);
  assert.equal(result.video.durationSeconds, 5.6);
  assert.equal(result.video.width, 1080);
  assert.equal(result.video.height, 1920);
});

test('an empty buffer is reported as unmeasured, never as zero', () => {
  const result = probeVideoContainer(Buffer.alloc(0));
  assert.equal(result.container, 'unknown');
  assert.equal(result.video, null);
  assert.equal(result.timeline, null);
  assert.ok(result.notes.some((note) => /Empty/i.test(note)));
});

test('a WebM buffer is identified and left unmeasured with a note', () => {
  const result = probeVideoContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]));
  assert.equal(result.container, 'webm');
  assert.equal(result.video, null);
  assert.ok(result.notes.some((note) => /WebM/i.test(note)));
});

test('garbage never throws', () => {
  const result = probeVideoContainer(Buffer.from('definitely not a video'));
  assert.equal(result.container, 'unknown');
  assert.ok(Array.isArray(result.notes));
});

test('the path probe streams a real file and refuses a missing one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'medkit-probe-'));
  try {
    const file = join(directory, 'clip.mp4');
    await writeFile(file, minimalMp4());
    const result = await probeVideoFileByPath(file);
    assert.equal(result.container, 'mp4');
    assert.equal(result.video.durationSeconds, 5.6);
    assert.equal(await probeVideoFileByPath(join(directory, 'missing.mp4')), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
