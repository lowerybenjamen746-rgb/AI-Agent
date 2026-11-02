import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_TEMP_PREFIXES,
  cleanupStaleWorkerTempDirectories,
  isWorkerTempDirectory,
} from '../src/temp-cleanup.mjs';

async function sandbox() {
  return mkdtemp(join(tmpdir(), 'media-worker-test-'));
}

test('only owned prefixes are recognised', () => {
  assert.equal(isWorkerTempDirectory('media-worker-render-abc'), true);
  assert.equal(isWorkerTempDirectory('render-abc'), false);
  assert.equal(isWorkerTempDirectory('not-ours'), false);
  assert.ok(DEFAULT_TEMP_PREFIXES.length > 0);
});

test('old owned directories are removed and fresh or foreign ones are kept', async () => {
  const root = await sandbox();
  try {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000);
    for (const name of ['media-worker-render-old', 'media-worker-asr-old', 'unrelated-dir', 'media-worker-render-new']) {
      await mkdir(join(root, name));
      if (name.endsWith('-old')) await utimes(join(root, name), oldDate, oldDate);
    }
    await writeFile(join(root, 'media-worker-render-file'), 'not a directory');

    const removed = await cleanupStaleWorkerTempDirectories({ root, prefixes: ['media-worker-render-', 'media-worker-asr-'] });
    assert.equal(removed, 2);
    const remaining = (await (await import('node:fs/promises')).readdir(root)).sort();
    assert.deepEqual(remaining, ['media-worker-render-file', 'media-worker-render-new', 'unrelated-dir']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a missing temp root is not a failure', async () => {
  assert.equal(await cleanupStaleWorkerTempDirectories({ root: join(tmpdir(), 'definitely-missing-root-xyz') }), 0);
});

test('an empty or wildcard prefix list is refused instead of deleting everything', async () => {
  const root = await sandbox();
  try {
    await mkdir(join(root, 'anything'));
    await assert.rejects(() => cleanupStaleWorkerTempDirectories({ root, prefixes: [] }), TypeError);
    await assert.rejects(() => cleanupStaleWorkerTempDirectories({ root, prefixes: [''] }), TypeError);
    assert.equal(await cleanupStaleWorkerTempDirectories({ root, prefixes: ['nomatch-'] }), 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
