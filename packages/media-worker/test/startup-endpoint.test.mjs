import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import test from 'node:test';

import {
  describeWorkerEndpoint,
  describeWorkerEnvironment,
  listenWithReporting,
  parseWorkerPort,
  resolveWorkerEndpoint,
  resolveWorkerHost,
} from '../src/startup-endpoint.mjs';

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
};

async function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = net.createServer();
    probe.once('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolvePort(port));
    });
  });
}

test('SERVER_PORT (platform-assigned port) takes precedence over every other source', () => {
  const endpoint = resolveWorkerEndpoint({ SERVER_PORT: '40311', MEDIA_WORKER_PORT: '8787', PORT: '3000', MEDIA_WORKER_HOST: '0.0.0.0' });
  assert.deepEqual(endpoint, { listen: true, port: 40311, host: '0.0.0.0', hostSource: 'MEDIA_WORKER_HOST', source: 'SERVER_PORT' });
});

test('MEDIA_WORKER_PORT and PORT keep working when SERVER_PORT is absent', () => {
  assert.deepEqual(resolveWorkerEndpoint({ MEDIA_WORKER_PORT: '40311', MEDIA_WORKER_HOST: '0.0.0.0' }),
    { listen: true, port: 40311, host: '0.0.0.0', hostSource: 'MEDIA_WORKER_HOST', source: 'MEDIA_WORKER_PORT' });
  assert.deepEqual(resolveWorkerEndpoint({ MEDIA_WORKER_PORT: '', PORT: '3000' }),
    { listen: true, port: 3000, host: '127.0.0.1', hostSource: 'default', source: 'PORT' });
  assert.deepEqual(resolveWorkerEndpoint({}), { listen: true, port: 8787, host: '127.0.0.1', hostSource: 'default', source: 'default' });
});

test('invalid port values fail clearly instead of silently binding another port', () => {
  for (const raw of ['abc', '0', '65536', '-1', '11.5', '8787x', '0x1f', '1e3']) {
    assert.throws(() => parseWorkerPort(raw, 'SERVER_PORT'), /SERVER_PORT=.* not a valid TCP port/, String(raw));
  }
  assert.equal(parseWorkerPort(undefined, 'SERVER_PORT'), null);
  assert.equal(parseWorkerPort('', 'SERVER_PORT'), null);
  assert.equal(parseWorkerPort(' 40311 ', 'SERVER_PORT'), 40311);
  assert.equal(parseWorkerPort('1', 'SERVER_PORT'), 1);
  assert.equal(parseWorkerPort('65535', 'SERVER_PORT'), 65535);
  assert.throws(
    () => resolveWorkerEndpoint({ SERVER_PORT: 'not-a-port', MEDIA_WORKER_PORT: '8787' }),
    /SERVER_PORT="not-a-port" is not a valid TCP port/,
  );
});

test('host binding keeps loopback by default and honours an explicit MEDIA_WORKER_HOST', () => {
  assert.equal(resolveWorkerHost({}), '127.0.0.1');
  assert.equal(resolveWorkerHost({ MEDIA_WORKER_HOST: '' }), '127.0.0.1');
  assert.equal(resolveWorkerHost({ MEDIA_WORKER_HOST: '   ' }), '127.0.0.1');
  assert.equal(resolveWorkerHost({ MEDIA_WORKER_HOST: ' 0.0.0.0 ' }), '0.0.0.0');
  assert.equal(resolveWorkerEndpoint({ MEDIA_WORKER_NO_LISTEN: '1', SERVER_PORT: '40311' }).listen, false);
});

test('the startup line names the resolved host and port and never echoes another environment value', () => {
  const line = describeWorkerEndpoint({ port: 40311, host: '0.0.0.0', source: 'SERVER_PORT' });
  assert.equal(line, 'Media worker listening on http://0.0.0.0:40311 (port from SERVER_PORT)');
  assert.doesNotMatch(line, /TOKEN|SECRET|KEY|PASSWORD/i);
});

test('invisible characters left in MEDIA_WORKER_HOST never change the bind address', () => {
  for (const value of ['0.0.0.0', ' 0.0.0.0 ', '\t0.0.0.0\t', '0.0.0.0\r', '\u200b0.0.0.0', '\ufeff0.0.0.0']) {
    assert.equal(resolveWorkerHost({ MEDIA_WORKER_HOST: value }), '0.0.0.0', JSON.stringify(value));
  }
  assert.equal(resolveWorkerHost({ MEDIA_WORKER_HOST: '\u00a0' }), '127.0.0.1');
  assert.equal(resolveWorkerHost({ MEDIA_WORKER_HOST: undefined }), '127.0.0.1');
});

test('the environment report names the bind variables and flags invisible characters', () => {
  assert.equal(describeWorkerEnvironment({}), 'MEDIA_WORKER_HOST=unset, MEDIA_WORKER_PORT=unset, SERVER_PORT=unset');
  assert.equal(describeWorkerEnvironment({ MEDIA_WORKER_HOST: '', SERVER_PORT: '40311' }), 'MEDIA_WORKER_HOST=empty, MEDIA_WORKER_PORT=unset, SERVER_PORT="40311"');
  assert.match(describeWorkerEnvironment({ MEDIA_WORKER_HOST: '\u200b0.0.0.0' }), /MEDIA_WORKER_HOST="0\.0\.0\.0" \(invisible characters removed\)/);
  const report = describeWorkerEnvironment({ MEDIA_WORKER_HOST: '0.0.0.0', MEDIA_WORKER_PORT: '40311', SERVER_PORT: '40311', MEDIA_WORKER_TOKEN: 'super-secret-token-value' });
  assert.equal(report, 'MEDIA_WORKER_HOST="0.0.0.0", MEDIA_WORKER_PORT="40311", SERVER_PORT="40311"');
  assert.doesNotMatch(report, /super-secret|TOKEN/i);
});

test('a platform-published SERVER_PORT chooses 0.0.0.0 only when no explicit host is set', () => {
  const platform = { SERVER_PORT: '40131', MEDIA_WORKER_PORT: '8787' };
  const cases = [
    [{ ...platform, MEDIA_WORKER_HOST: '0.0.0.0' }, '0.0.0.0', 'MEDIA_WORKER_HOST'],
    [{ ...platform, MEDIA_WORKER_HOST: '127.0.0.1' }, '127.0.0.1', 'MEDIA_WORKER_HOST'],
    [{ ...platform, MEDIA_WORKER_HOST: '::' }, '::', 'MEDIA_WORKER_HOST'],
    [platform, '0.0.0.0', 'SERVER_PORT (platform-published)'],
    [{ ...platform, MEDIA_WORKER_HOST: '' }, '0.0.0.0', 'SERVER_PORT (platform-published)'],
    [{ ...platform, MEDIA_WORKER_HOST: '   ' }, '0.0.0.0', 'SERVER_PORT (platform-published)'],
    [{ ...platform, MEDIA_WORKER_HOST: '\u200b\u00a0' }, '0.0.0.0', 'SERVER_PORT (platform-published)'],
  ];
  for (const [env, host, hostSource] of cases) {
    const endpoint = resolveWorkerEndpoint(env);
    assert.equal(endpoint.host, host, JSON.stringify(env));
    assert.equal(endpoint.hostSource, hostSource, JSON.stringify(env));
    assert.equal(endpoint.port, 40131);
  }
  for (const env of [{}, { MEDIA_WORKER_PORT: '8787' }, { PORT: '3000' }, { MEDIA_WORKER_HOST: '' }]) {
    assert.equal(resolveWorkerEndpoint(env).host, '127.0.0.1', JSON.stringify(env));
    assert.equal(resolveWorkerEndpoint(env).hostSource, 'default', JSON.stringify(env));
  }
});

test('an unusable SERVER_PORT never triggers the platform bind and still fails clearly', () => {
  for (const SERVER_PORT of ['abc', '0', '70000', '40.5']) {
    assert.throws(() => resolveWorkerEndpoint({ SERVER_PORT, MEDIA_WORKER_PORT: '8787' }), /SERVER_PORT=.*not a valid TCP port/);
    assert.equal(resolveWorkerHost({ SERVER_PORT }), '127.0.0.1', SERVER_PORT);
    assert.equal(resolveWorkerEndpoint({ SERVER_PORT: '', MEDIA_WORKER_PORT: '8787' }).host, '127.0.0.1');
  }
});

test('the listening line reports the address Node actually bound, not the requested host', async () => {
  const lines = [];
  const server = http.createServer((_, response) => response.end('ok'));
  listenWithReporting(server, { port: 0, host: '0.0.0.0', source: 'SERVER_PORT', log: (line) => lines.push(line), exit: () => {} });
  await waitFor(() => lines.length > 0);
  const bound = server.address();
  assert.match(lines[0], new RegExp(`^Media worker listening on http://0\\.0\\.0\\.0:${bound.port} \\(port from SERVER_PORT\\) env: `));
  await new Promise((resolve) => server.close(resolve));
});

test('a real listener logs its host and port, and a bind failure is logged and exits non-zero', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const lines = [];
  const ok = http.createServer((_, response) => response.end('ok'));
  listenWithReporting(ok, { port, host: '127.0.0.1', source: 'SERVER_PORT', log: (line) => lines.push({ level: 'log', line }), logError: (line) => lines.push({ level: 'error', line }) });
  await waitFor(() => lines.length > 0);
  assert.equal(lines.length, 1);
  await new Promise((resolve) => ok.close(resolve));

  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(port, '127.0.0.1', resolve));
  const failures = [];
  const exitCodes = [];
  const previousExitCode = process.exitCode;
  listenWithReporting(http.createServer(), {
    port,
    host: '127.0.0.1',
    source: 'SERVER_PORT',
    log: () => failures.push('unexpected listening'),
    logError: (line) => failures.push(line),
    exit: (code) => exitCodes.push(code),
  });
  await waitFor(() => exitCodes.length > 0);
  await new Promise((resolve) => blocker.close(resolve));
  assert.equal(failures.length, 1, 'bind failure is logged exactly once');
  assert.match(failures[0], /Media worker failed to bind 127\.0\.0\.1:\d+ \(port from SERVER_PORT\): EADDRINUSE/);
  assert.deepEqual(exitCodes, [1], 'a bind failure exits non-zero instead of idling');
  process.exitCode = previousExitCode;
});

test('with SERVER_PORT and no host the real listener binds 0.0.0.0', { timeout: 30_000 }, async () => {
  const port = await freePort();
  const endpoint = resolveWorkerEndpoint({ SERVER_PORT: String(port), MEDIA_WORKER_PORT: '8787' });
  assert.equal(endpoint.host, '0.0.0.0');
  const lines = [];
  const server = http.createServer((_, response) => response.end('ok'));
  listenWithReporting(server, { ...endpoint, log: (line) => lines.push(line), exit: () => {} });
  await waitFor(() => lines.length > 0);
  const bound = server.address();
  assert.equal(bound.address, '0.0.0.0');
  assert.equal(bound.port, port);
  assert.match(lines[0], /host from SERVER_PORT \(platform-published\)/);
  await new Promise((resolve) => server.close(resolve));
});
