#!/usr/bin/env node
// Repository hygiene checks that do not need a linter in the dependency tree:
// license/package consistency, no committed environment files, no binaries, and
// no credential-shaped strings in tracked text files.
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const problems = [];

function trackedFiles() {
  return execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
}

function fail(message) {
  problems.push(message);
}

function checkLicenses() {
  const expected = {
    'packages/media-worker/package.json': 'GPL-3.0-or-later',
    'packages/medkit/package.json': 'GPL-3.0-or-later',
    'packages/transcript-utils/package.json': 'MIT',
  };
  for (const [file, license] of Object.entries(expected)) {
    const manifest = JSON.parse(readFileSync(file, 'utf8'));
    if (manifest.license !== license) fail(`${file}: license is "${manifest.license}", expected "${license}"`);
  }
  for (const required of ['LICENSE', 'LICENSES/GPL-3.0-or-later.txt', 'LICENSES/MIT.txt']) {
    try { statSync(required); } catch { fail(`${required} is missing`); }
  }
}

// Files that necessarily CONTAIN the patterns they look for, and vendored
// license text: scanning them would only match the scanner itself.
const SCAN_EXEMPT = new Set(['scripts/repository-check.mjs', '.github/workflows/ci.yml']);

// Built from fragments so this file does not itself contain a matching literal.
const CREDENTIAL_PATTERNS = [
  new RegExp(['eyJ', 'hbGciOi'].join('')),
  new RegExp(['gh', 'p_'].join('') + '[A-Za-z0-9]{20,}'),
  new RegExp(['s', 'k-'].join('') + '[A-Za-z0-9]{20,}'),
  new RegExp(['AK', 'IA'].join('') + '[0-9A-Z]{16}'),
  new RegExp(['-----BEGIN ', '[A-Z ]*PRIVATE KEY-----'].join('')),
  new RegExp(['AI', 'za'].join('') + '[0-9A-Za-z_-]{35}'),
];

function checkTrackedFiles(files) {
  for (const file of files) {
    if (/(^|\/)\.env($|\.)/.test(file) && !file.endsWith('.env.example')) fail(`environment file is tracked: ${file}`);
    if (file.endsWith('.pem') || file.endsWith('.key')) fail(`key file is tracked: ${file}`);
    if (file.startsWith('dist/') || file.includes('/dist/')) fail(`build output is tracked: ${file}`);
  }
}

function checkContents(files) {
  for (const file of files) {
    if (SCAN_EXEMPT.has(file)) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) {
      if (execFileSync('file', ['-b', file], { encoding: 'utf8' }).includes('ELF')) fail(`binary is tracked: ${file}`);
      continue;
    }
    for (const pattern of CREDENTIAL_PATTERNS) {
      if (pattern.test(text)) { fail(`credential-shaped string in ${file}`); break; }
    }
  }
}

checkLicenses();
const files = trackedFiles();
checkTrackedFiles(files);
checkContents(files);

if (problems.length > 0) {
  console.error(`repository check failed (${problems.length}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`repository check passed (${files.length} tracked files)`);
