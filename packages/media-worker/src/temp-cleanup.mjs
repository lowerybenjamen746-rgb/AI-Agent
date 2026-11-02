import { readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

export const WORKER_TEMP_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Thread-safe defaults for the directories this worker creates.
 *
 * A long-lived worker has no process exit to clean up after, so any prefix it
 * creates that is missing from this list is a directory that can never be
 * reclaimed. Hosts that create their own directories pass `prefixes` instead.
 */
export const DEFAULT_TEMP_PREFIXES = Object.freeze([
  'media-worker-source-',
  'media-worker-analysis-',
  'media-worker-asr-',
  'media-worker-render-',
  'media-worker-render-qa-',
  'media-worker-output-qa-',
  'media-worker-ffmpeg-',
  'media-worker-fontconfig-',
]);

/**
 * @param {string} name directory entry name
 * @param {readonly string[]} [prefixes] owned prefixes (defaults to DEFAULT_TEMP_PREFIXES)
 */
export function isWorkerTempDirectory(name, prefixes = DEFAULT_TEMP_PREFIXES) {
  return prefixes.some((prefix) => name.startsWith(prefix));
}

/**
 * Remove only old directories owned by this worker.
 *
 * `prefixes` must be non-empty: an empty list would make the reaper a no-op
 * that silently reports success, and a list of `['']` would match every
 * directory in the temp root. Both are refused rather than acted on.
 */
export async function cleanupStaleWorkerTempDirectories({
  root = tmpdir(),
  now = Date.now(),
  maxAgeMs = WORKER_TEMP_RETENTION_MS,
  prefixes = DEFAULT_TEMP_PREFIXES,
} = {}) {
  if (!Array.isArray(prefixes) || prefixes.length === 0 || prefixes.some((prefix) => typeof prefix !== 'string' || prefix.length === 0)) {
    throw new TypeError('cleanupStaleWorkerTempDirectories requires a non-empty list of non-empty prefixes');
  }
  // A missing temp root is nothing to reclaim, not a startup failure: this runs
  // before `listen()` and must never prevent the worker from serving.
  const entries = await readdir(root, { withFileTypes: true }).catch(error => {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return [];
    throw error;
  });
  const cutoff = now - maxAgeMs;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !isWorkerTempDirectory(entry.name, prefixes)) continue;
    const directory = `${root}/${entry.name}`;
    const details = await stat(directory).catch(() => null);
    if (!details || details.mtimeMs > cutoff) continue;
    await rm(directory, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
