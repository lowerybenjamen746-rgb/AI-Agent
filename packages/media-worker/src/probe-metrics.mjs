#!/usr/bin/env node
/**
 * Local, read-only resource probe for a media worker host.
 *
 * Prints ONE JSON object with host measurements a coordinator can consume as a
 * metrics report. It never invents a value: anything the host cannot report is
 * `null`, and the consumer renders that as "unknown".
 *
 * Usage (on the worker host; this is never exposed over the network):
 *   node src/probe-metrics.mjs
 *   node src/probe-metrics.mjs --temp-dir /var/task
 *
 * Deliberately read-only: it reads OS counters, one statfs and one directory
 * listing. It starts no process, touches no job and writes nothing.
 */
import { readdirSync, statfsSync, statSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem } from 'node:os';
import { join } from 'node:path';

/** Recursive size in bytes for a directory tree, or null when unreadable. */
function directoryUsage(root, depth = 0) {
  if (depth > 8) return null;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  let bytes = 0;
  let count = 0;
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = directoryUsage(full, depth + 1);
      if (nested !== null) {
        bytes += nested.bytes;
        count += nested.entries;
      }
      continue;
    }
    try {
      bytes += statSync(full).size;
      count += 1;
    } catch {
      // Skip an entry that vanished or cannot be stat'ed.
    }
  }
  return { bytes, entries: count };
}

function diskFor(path) {
  try {
    const stats = statfsSync(path);
    return { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {
    return null;
  }
}

const tempDirIndex = process.argv.indexOf('--temp-dir');
const tempDir = tempDirIndex !== -1 && process.argv[tempDirIndex + 1]
  ? process.argv[tempDirIndex + 1]
  : process.env.TMPDIR ?? '/tmp';

const load = loadavg();
const temp = directoryUsage(tempDir);

const report = {
  sampledAt: new Date().toISOString(),
  pid: process.pid,
  node: process.version,
  ram: { totalBytes: totalmem(), freeBytes: freemem() },
  cpu: { cores: cpus().length, loadAverage: Number.isFinite(load[0]) ? Number(load[0].toFixed(2)) : null },
  disk: diskFor(tempDir),
  temp: temp === null ? null : { bytes: temp.bytes, entries: temp.entries },
  tempDir,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
