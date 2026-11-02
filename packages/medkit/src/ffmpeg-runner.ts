/**
 * Native FFmpeg execution backend.
 *
 * This module is an EXECUTION BACKEND, not a renderer: it runs FFmpeg argument
 * lists a caller already produced. It owns discovery, capability proof,
 * binary/font staging for read-only bundles, bounded execution with progress
 * parsed from FFmpeg's own output, and cancellation.
 *
 * Server-only: it imports `node:child_process` and `node:fs`.
 *
 * Provenance: adapted from ClipForge's `src/lib/ffmpeg/server-runtime.ts`.
 * The fleet-specific parts (invocation budgets from a private pipeline, the
 * project's media-selection policy, its resource ledger, and its own render
 * filter list) were removed; discovery, staging, probing and execution were
 * kept and are covered by this package's tests.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as FS_CONSTANTS,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

export interface FFmpegEvent {
  type?: string;
  message?: string;
  progress?: number;
  time?: number;
}

export interface FFmpegRuntime {
  readonly loaded: boolean;
  on(event: 'log' | 'progress', handler: (event: FFmpegEvent) => void): void;
  off(event: 'log' | 'progress', handler: (event: FFmpegEvent) => void): void;
  exec(args: string[]): Promise<number>;
  writeFile(name: string, data: Uint8Array | string): Promise<boolean>;
  readFile(name: string): Promise<Uint8Array | string>;
  deleteFile(name: string): Promise<boolean>;
}

export interface FFmpegCapability {
  /** True when a probed, executable build that has every required capability was found. */
  available: boolean;
  /** Absolute path of the binary that will be used. */
  binary: string | null;
  /** How the binary was located (`FFMPEG_PATH`, `ffmpeg-static`, `PATH`, `known location`). */
  source: string;
  /** First line of `ffmpeg -version`, for diagnostics. */
  version: string | null;
  /** Required filters this build does not provide. */
  missingFilters: string[];
  /** Required encoders this build does not provide. */
  missingEncoders: string[];
  /** Why the text render probe failed, or null. */
  textRenderError: string | null;
  /** True when the binary was copied into tmp because the original was not executable. */
  staged: boolean;
  /** Actionable explanation when `available` is false. */
  reason: string | null;
}

/** Encoders nearly every transcode preset needs (H.264 video and AAC audio). */
export const DEFAULT_REQUIRED_ENCODERS = ['libx264', 'aac'] as const;

/**
 * Filters needed for the built-in crop/scale/subtitle/overlay chain. Callers
 * with a different chain pass their own list as `requiredFilters`.
 */
export const DEFAULT_REQUIRED_FILTERS = [
  'drawtext',
  'subtitles',
  'overlay',
  'format',
  'fade',
  'crop',
  'scale',
  'trim',
  'concat',
  'volume',
  'amix',
] as const;

/** Time allowed for the one-off `ffmpeg -version` / `-filters` probes. */
export const PROBE_TIMEOUT_MS = 5_000;

/** Wall-clock bound of a single FFmpeg invocation unless the caller sets one. */
export const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

const BUNDLED_BINARY = join('node_modules', 'ffmpeg-static', 'ffmpeg');
const BUNDLED_TEXT_ASSET_DIR = join('assets', 'ffmpeg');
const BUNDLED_TEXT_CONFIG = 'fonts.conf';
const TEXT_FONT_DIR_TOKEN = '@FONT_DIR@';

const KNOWN_LOCATIONS = [
  '/usr/bin/ffmpeg',
  '/usr/local/bin/ffmpeg',
  '/bin/ffmpeg',
  '/opt/homebrew/bin/ffmpeg',
  '/usr/local/opt/ffmpeg/bin/ffmpeg',
];

export interface DiscoverOptions {
  /** Environment to read (`FFMPEG_PATH`, `PATH`). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Check for a bundled `node_modules/ffmpeg-static/ffmpeg` under `cwd`. */
  cwd?: string;
  includeBundled?: boolean;
  includeKnownLocations?: boolean;
}

interface Candidate {
  binary: string;
  source: string;
}

function isExecutableFile(path: string): boolean {
  try {
    if (!existsSync(path)) return false;
    accessSync(path, FS_CONSTANTS.X_OK);
    return true;
  } catch {
    return false;
  }
}

const stagedBinaries = new Map<string, string>();
const stagedDirectories = new Set<string>();
let exitCleanupRegistered = false;

function registerExitCleanup(): void {
  if (exitCleanupRegistered) return;
  exitCleanupRegistered = true;
  process.once('exit', () => {
    for (const directory of stagedDirectories) {
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best effort: a leftover temp directory must never break shutdown.
      }
    }
  });
}

/**
 * Resolve a usable path for `source`.
 *
 * Read-only bundles (serverless images, containers) may ship a binary without
 * its execute bit. The same binary is then copied into `$TMPDIR` with mode 0755
 * and reused for the life of the process — never a different build.
 */
function executablePath(source: string): { path: string; staged: boolean } | null {
  if (!existsSync(source)) return null;
  if (isExecutableFile(source)) return { path: source, staged: false };

  const cached = stagedBinaries.get(source);
  if (cached && isExecutableFile(cached)) return { path: cached, staged: true };

  try {
    chmodSync(source, 0o755);
    if (isExecutableFile(source)) return { path: source, staged: false };
  } catch {
    // Read-only: fall through to staging.
  }

  try {
    const directory = mkdtempSync(join(tmpdir(), 'medkit-ffmpeg-'));
    const staged = join(directory, 'ffmpeg');
    copyFileSync(source, staged);
    chmodSync(staged, 0o755);
    if (!isExecutableFile(staged)) return null;
    stagedBinaries.set(source, staged);
    stagedDirectories.add(directory);
    registerExitCleanup();
    return { path: staged, staged: true };
  } catch {
    return null;
  }
}

function candidates(options: DiscoverOptions = {}): Candidate[] {
  const env = options.env ?? process.env;
  const explicit = env.FFMPEG_PATH?.trim();
  // An explicitly configured binary is authoritative: if it is broken that is a
  // configuration error to report, never a reason to silently use another build.
  if (explicit) return [{ binary: explicit, source: 'FFMPEG_PATH' }];

  const list: Candidate[] = [];
  if (options.includeBundled !== false) {
    list.push({ binary: join(options.cwd ?? process.cwd(), BUNDLED_BINARY), source: 'ffmpeg-static' });
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir.trim().length > 0) list.push({ binary: join(dir, 'ffmpeg'), source: 'PATH' });
  }
  if (options.includeKnownLocations !== false) {
    for (const known of KNOWN_LOCATIONS) list.push({ binary: known, source: 'known location' });
  }
  return list;
}

function probeBinary(binary: string, timeoutMs = PROBE_TIMEOUT_MS): { ok: boolean; detail: string } {
  try {
    const result = spawnSync(binary, ['-version'], { timeout: timeoutMs, encoding: 'utf8' });
    if (result.error) return { ok: false, detail: result.error.message };
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.status !== 0) return { ok: false, detail: `exited with code ${result.status}` };
    if (!/ffmpeg version/i.test(output)) return { ok: false, detail: 'the file is not an FFmpeg build' };
    return { ok: true, detail: output.split(/\r?\n/)[0]?.trim() ?? 'ffmpeg' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

function listMissing(binary: string, listFlag: '-filters' | '-encoders', required: readonly string[]): string[] {
  try {
    const result = spawnSync(binary, ['-hide_banner', listFlag], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    return required.filter((name) => !new RegExp(`\\b${name}\\b`).test(output));
  } catch {
    return [...required];
  }
}

const textRenderProbes = new Map<string, string | null>();

let nativeTextEnvironment: { env: NodeJS.ProcessEnv; directory: string } | null = null;

/**
 * Stage a font and a private fontconfig file so text filters do not depend on
 * the host's `/etc/fonts`. Returns null when the assets are not present, in
 * which case a text probe reports a clear failure instead of guessing.
 */
export function stageTextAssets({ cwd = process.cwd(), fontDirToken = TEXT_FONT_DIR_TOKEN } = {}) {
  if (nativeTextEnvironment) return nativeTextEnvironment;
  const root = join(cwd, BUNDLED_TEXT_ASSET_DIR);
  const configSource = join(root, BUNDLED_TEXT_CONFIG);
  const fontSource = join(root, 'fonts', 'drawtext.ttf');
  if (!existsSync(configSource) || !existsSync(fontSource)) {
    throw new Error(`Bundled native text assets are missing under ${root}; provide assets/ffmpeg/fonts.conf and fonts/drawtext.ttf`);
  }
  const template = readFileSync(configSource, 'utf8');
  if (!template.includes(fontDirToken)) throw new Error(`bundled fontconfig template is missing ${fontDirToken}`);

  const directory = mkdtempSync(join(tmpdir(), 'medkit-fontconfig-'));
  const fontDirectory = join(directory, 'fonts');
  mkdirSync(fontDirectory, { recursive: true, mode: 0o755 });
  copyFileSync(fontSource, join(fontDirectory, 'drawtext.ttf'));
  const config = join(directory, 'fonts.conf');
  writeFileSync(config, template.replaceAll(fontDirToken, fontDirectory), { encoding: 'utf8', mode: 0o644 });
  stagedDirectories.add(directory);
  registerExitCleanup();
  nativeTextEnvironment = { directory, env: { ...process.env, FONTCONFIG_FILE: config, FONTCONFIG_PATH: directory } };
  return nativeTextEnvironment;
}

/** Prove that `drawtext` can actually draw in THIS runtime (libfreetype + a font). */
export function probeTextRender(binary: string, textEnv?: NodeJS.ProcessEnv): string | null {
  if (textRenderProbes.has(binary)) return textRenderProbes.get(binary) ?? null;
  let detail: string | null = null;
  try {
    const env = textEnv ?? stageTextAssets().env;
    const result = spawnSync(binary, [
      '-hide_banner', '-v', 'error',
      '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=1',
      '-vf', 'drawtext=text=medkit:fontsize=16:x=0:y=0',
      '-frames:v', '1', '-f', 'null', '-',
    ], { timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', env });
    if (result.error) detail = result.error.message;
    else if (result.status !== 0) {
      detail = `${result.stderr ?? ''}`.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
        ?? `exited with code ${result.status}`;
    }
  } catch (error) {
    detail = error instanceof Error ? error.message : String(error);
  }
  textRenderProbes.set(binary, detail);
  return detail;
}

export interface DetectOptions extends DiscoverOptions {
  requiredFilters?: readonly string[];
  requiredEncoders?: readonly string[];
  /** Probe a real text render (needs font assets). Default false. */
  checkTextRender?: boolean;
}

/**
 * Locate and prove a usable FFmpeg build.
 *
 * The first candidate that is a real FFmpeg build decides the outcome: if it
 * lacks a required capability, detection fails naming the exact gap. It never
 * silently substitutes another build.
 */
export function detectFFmpeg(options: DetectOptions = {}): FFmpegCapability {
  const requiredFilters = options.requiredFilters ?? DEFAULT_REQUIRED_FILTERS;
  const requiredEncoders = options.requiredEncoders ?? DEFAULT_REQUIRED_ENCODERS;
  const failures: string[] = [];

  for (const candidate of candidates(options)) {
    const usable = executablePath(candidate.binary);
    if (!usable) {
      failures.push(`${candidate.source}: ${candidate.binary} is not an executable file`);
      continue;
    }
    const probe = probeBinary(usable.path);
    if (!probe.ok) {
      failures.push(`${candidate.source}: ${candidate.binary} - ${probe.detail}`);
      continue;
    }
    const missingFilters = listMissing(usable.path, '-filters', requiredFilters);
    const missingEncoders = listMissing(usable.path, '-encoders', requiredEncoders);
    const textRenderError = options.checkTextRender && missingFilters.length === 0 ? probeTextRender(usable.path) : null;

    if (missingFilters.length > 0 || missingEncoders.length > 0 || textRenderError) {
      const parts: string[] = [];
      if (missingFilters.length) parts.push(`missing filters: ${missingFilters.join(', ')}`);
      if (missingEncoders.length) parts.push(`missing encoders: ${missingEncoders.join(', ')}`);
      if (textRenderError) parts.push(`text render probe failed: ${textRenderError}`);
      return {
        available: false,
        binary: usable.path,
        source: candidate.source,
        version: probe.detail,
        missingFilters,
        missingEncoders,
        textRenderError,
        staged: usable.staged,
        reason: `A real FFmpeg build was found (${candidate.source}: ${candidate.binary}) but it cannot run the required chain (${parts.join('; ')}); it is refused instead of swapped for another build.`,
      };
    }
    return { available: true, binary: usable.path, source: candidate.source, version: probe.detail, missingFilters, missingEncoders, textRenderError, staged: usable.staged, reason: null };
  }

  const detail = failures.length > 0 ? ` (${failures.slice(0, 3).join('; ')})` : '';
  return { available: false, binary: null, source: 'none', version: null, missingFilters: [], missingEncoders: [], textRenderError: null, staged: false, reason: `No usable FFmpeg binary was found. Set FFMPEG_PATH, or put ffmpeg on PATH.${detail}` };
}

function durationSeconds(line: string): number | null {
  const match = line.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

function elapsedSeconds(line: string): number | null {
  const match = line.match(/time=\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : null;
}

export interface RunInput {
  binary: string;
  args: string[];
  workingDirectory: string;
  /** Wall-clock bound for this invocation. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  onLog?: (event: FFmpegEvent) => void;
  onProgress?: (event: FFmpegEvent) => void;
}

/**
 * Run one FFmpeg invocation and resolve with its exit code.
 *
 * Progress comes only from the encoding time FFmpeg itself prints, and only
 * once the input duration is known: no progress is emitted from an estimate.
 * SIGKILL does not settle the promise; the single settle point is `close`, so a
 * killed encode is awaited instead of being reported while still dying.
 */
export async function runFFmpeg(input: RunInput): Promise<number> {
  const { binary, args, workingDirectory, timeoutMs = DEFAULT_EXEC_TIMEOUT_MS, env = process.env, signal, onLog, onProgress } = input;
  signal?.throwIfAborted();
  return await new Promise<number>((resolve, reject) => {
    const child = spawn(binary, args, { cwd: workingDirectory, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let settled = false;
    let timedOut = false;
    const abort = (): void => { child.kill('SIGKILL'); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    let totalSeconds: number | null = null;

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const handleLine = (line: string): void => {
      if (line.length === 0) return;
      onLog?.({ type: 'stderr', message: line });
      const measured = durationSeconds(line);
      if (measured !== null && totalSeconds === null) totalSeconds = measured;
      const seconds = elapsedSeconds(line);
      if (seconds !== null && totalSeconds !== null && totalSeconds > 0) {
        onProgress?.({ progress: Math.min(1, seconds / totalSeconds), time: seconds });
      }
    };

    let buffered = '';
    const consume = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split(/\r\n|\n|\r/);
      buffered = lines.pop() ?? '';
      for (const line of lines) handleLine(line.trim());
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);

    child.on('error', (error) => {
      if (settled || timedOut) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(error);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (settled) return;
      settled = true;
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('FFmpeg cancelled'));
        return;
      }
      if (buffered.trim().length > 0) handleLine(buffered.trim());
      if (timedOut) {
        reject(new Error(`FFmpeg exceeded the ${timeoutMs}ms budget`));
        return;
      }
      resolve(code ?? 0);
    });
  });
}

function resolveInWorkspace(directory: string, name: string): string {
  const target = join(directory, name);
  const root = directory.endsWith('/') ? directory : `${directory}/`;
  if (!target.startsWith(root)) throw new Error(`Refusing to touch a render file outside the workspace: ${name}`);
  return target;
}

/** Adapter with a flat per-instance workspace, mirroring ffmpeg.wasm's file API. */
function createNativeRuntime(binary: string, options: { timeoutMs?: number } = {}): FFmpegRuntime {
  const logHandlers = new Set<(event: FFmpegEvent) => void>();
  const progressHandlers = new Set<(event: FFmpegEvent) => void>();
  let workspace: string | null = null;

  const directory = async (): Promise<string> => {
    if (!workspace) {
      workspace = await mkdtemp(join(tmpdir(), 'medkit-render-'));
      stagedDirectories.add(workspace);
      registerExitCleanup();
    }
    return workspace;
  };

  const emit = (handlers: Set<(event: FFmpegEvent) => void>, event: FFmpegEvent): void => {
    for (const handler of handlers) {
      try { handler(event); } catch { /* a consumer must never fail a render */ }
    }
  };

  return {
    loaded: true,
    on(event, handler) { (event === 'log' ? logHandlers : progressHandlers).add(handler); },
    off(event, handler) { (event === 'log' ? logHandlers : progressHandlers).delete(handler); },
    async writeFile(name, data) {
      const dir = await directory();
      await writeFile(resolveInWorkspace(dir, name), typeof data === 'string' ? data : Buffer.from(data));
      return true;
    },
    async readFile(name) {
      const dir = await directory();
      return new Uint8Array(await readFile(resolveInWorkspace(dir, name)));
    },
    async deleteFile(name) {
      const dir = await directory();
      try { await unlink(resolveInWorkspace(dir, name)); return true; } catch { return false; }
    },
    async exec(args) {
      const dir = await directory();
      return await runFFmpeg({
        binary,
        args,
        workingDirectory: dir,
        timeoutMs: options.timeoutMs,
        onLog: (event) => emit(logHandlers, event),
        onProgress: (event) => emit(progressHandlers, event),
      });
    },
  };
}

const runtimes = new Map<string, FFmpegRuntime>();

/** Return (and cache) the native runtime for this binary, or null when unavailable. */
export function createFFmpegRuntime(capability: FFmpegCapability = detectFFmpeg(), options: { timeoutMs?: number } = {}): FFmpegRuntime | null {
  if (!capability.available || !capability.binary) return null;
  let runtime = runtimes.get(capability.binary);
  if (!runtime) {
    runtime = createNativeRuntime(capability.binary, options);
    runtimes.set(capability.binary, runtime);
  }
  return runtime;
}

export { dirname as parentDirectory };
