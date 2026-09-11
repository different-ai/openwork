import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const workflow = await fs.readFile(new URL('../../.github/workflows/ci-tests.yml', import.meta.url), 'utf8');
const job = workflow.match(/^  openwork-tests-build:\n(?:(?!^  \S)[\s\S])*/m)?.[0];
assert.ok(job, 'build job exists');
const step = job.match(/^      - name: Prepare virtual display\n(?:(?!^      - name:)[\s\S])*/m)?.[0];
assert.ok(step, 'inline display step exists');
// Parse only this workflow's literal run block; fail rather than guess at YAML variants.
const block = step.match(/^        run: \|\n((?:^          .*\n|^\n)+)/m)?.[1];
assert.ok(block, 'display step uses a literal, ten-space-indented Bash block');
assert.ok(step.endsWith(block), 'the extracted block includes the entire step recipe');
const script = block.replace(/^ {10}/gm, '');
const keyring = '/usr/share/keyrings/ubuntu-archive-keyring.gpg';
const sources = [
  `deb [signed-by=${keyring}] https://archive.ubuntu.com/ubuntu jammy main universe`,
  `deb [signed-by=${keyring}] https://archive.ubuntu.com/ubuntu jammy-updates main universe`,
  `deb [signed-by=${keyring}] https://security.ubuntu.com/ubuntu jammy-security main universe`,
].join('\n') + '\n';
const transport = 'Could not wait for server fd - select (11: Resource temporarily unavailable) [IP: 192.0.2.1 443] (TLSWaitFd)';
const failure = (detail) => ({
  status: 100,
  output: `Hit:1 https://archive.ubuntu.com/ubuntu jammy InRelease\nGet:2 https://archive.ubuntu.com/ubuntu jammy-updates InRelease [128 kB]\nIgn:3 https://security.ubuntu.com/ubuntu jammy-security InRelease\nErr:3 https://security.ubuntu.com/ubuntu jammy-security InRelease\n  ${detail}\nFetched 128 kB in 20s (6400 B/s)\nReading package lists...\nE: Failed to fetch https://security.ubuntu.com/ubuntu/dists/jammy-security/InRelease  ${detail}\nE: Some index files failed to download. They have been ignored, or old ones used instead.\n`,
});

test('bootstrap is first, fixed to Jammy, inline, and only elevates bounded OS APT', async () => {
  assert.match(job, /runs-on: blacksmith-16vcpu-ubuntu-2204\n/);
  assert.match(job, /^    steps:\n(?:      #[^\n]*\n)*      - name: Prepare virtual display\n/m);
  assert.equal(job.match(/^      - name: (.+)$/m)?.[1], 'Prepare virtual display');
  assert.ok(job.indexOf(step) < job.indexOf('uses: actions/checkout@'));
  assert.equal((step.match(/\buses:/g) ?? []).length, 0);
  assert.match(step, /timeout-minutes: 6\n        shell: bash\n/);
  assert.match(script, /unset APT_CONFIG/);
  assert.match(script, /export PATH=\/usr\/sbin:\/usr\/bin:\/sbin:\/bin LC_ALL=C/);
  assert.deepEqual(script.split('\n').filter((line) => /\bsudo\b/.test(line)).map((line) => line.trim()), [
    'if sudo /usr/bin/timeout --signal=TERM --kill-after=5s 60s /usr/bin/apt-get "${apt_options[@]}" update --error-on=any > "$apt_dir/update.log" 2>&1; then',
    'sudo /usr/bin/timeout --signal=TERM --kill-after=5s 120s /usr/bin/apt-get "${apt_options[@]}" install -y xvfb x11-utils',
  ]);
  assert.doesNotMatch(script, /\/etc\/apt|\bnode\b|scripts\/|\$\{\{|\s-c\s|\s-E\s|trusted=yes|[Aa]llow[Ii]nsecure|[Aa]llow[Uu]nauthenticated|[Vv]erify-(?:Peer|Host)|[Hh]ook|Pre-Invoke|Post-Invoke|-qq/);
  assert.deepEqual(script.match(/https?:\/\/[^\s'"}]+/g), sources.match(/https?:\/\/\S+/g));
  assert.equal(script.split('\n').filter((line) => line.includes('apt-get')).length, 2);
  assert.match(job, /run: node --test scripts\/ci\/ubuntu-apt-https.test.mjs/);
  await assert.rejects(fs.access(new URL('./ubuntu-apt-https.mjs', import.meta.url)), { code: 'ENOENT' });
  const syntax = spawnSync('/bin/bash', ['-n'], { input: script, encoding: 'utf8' });
  assert.equal(syntax.status, 0, syntax.stderr);
});

async function execute(t, options = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), 'apt-contract-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  await fs.mkdir(bin);
  const release = join(root, 'os-release');
  const testKeyring = join(root, 'archive-keyring.gpg');
  await fs.writeFile(release, options.release ?? 'ID=ubuntu\nVERSION_ID="22.04"\nVERSION_CODENAME=jammy\n');
  if (!options.noKeyring) await fs.writeFile(testKeyring, 'fixture keyring, never used by real APT');
  await fs.writeFile(join(root, 'scenario.json'), JSON.stringify(options));
  await fs.writeFile(join(root, 'calls.json'), '[]');

  // No real sudo, timeout, dpkg or apt-get can run: PATH is private, all absolute
  // privileged command paths are replaced, and sudo only records/simulates them.
  const stub = `#!${process.execPath}
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { basename, join } from 'node:path';
const root = process.env.TEST_ROOT;
const bin = join(root, 'bin');
const scenario = JSON.parse(fs.readFileSync(join(root, 'scenario.json'), 'utf8'));
const callPath = join(root, 'calls.json');
const calls = JSON.parse(fs.readFileSync(callPath, 'utf8'));
const args = process.argv.slice(2);
const command = basename(process.argv[1]);
const record = (entry) => {
  calls.push(entry);
  fs.writeFileSync(callPath, JSON.stringify(calls));
};
const provide = (name) => fs.writeFileSync(join(bin, name), '#!/bin/bash\\nexit 0\\n', { mode: 0o755 });
if (command === 'dpkg') {
  assert.deepEqual(args, ['--print-architecture']);
  process.stdout.write(scenario.architecture ?? 'amd64');
} else if (command === 'sleep') {
  record({ command, args });
} else if (command === 'sudo') {
  assert.equal(process.env.APT_CONFIG, undefined);
  assert.equal(process.env.LC_ALL, 'C');
  assert.equal(args[0], join(bin, 'timeout'));
  assert.deepEqual(args.slice(1, 3), ['--signal=TERM', '--kill-after=5s']);
  assert.equal(args[4], join(bin, 'apt-get'));
  const operation = args.includes('update') ? 'update' : 'install';
  assert.equal(args[3], operation === 'update' ? '60s' : '120s');
  const aptArgs = args.slice(5);
  const listPath = aptArgs[1].replace('Dir::Etc::sourcelist=', '');
  const partsPath = aptArgs[3].replace('Dir::Etc::sourceparts=', '');
  assert.ok(listPath.startsWith(root + '/apt.'));
  assert.equal(partsPath, listPath.replace('/sources.list', '/sourceparts'));
  assert.deepEqual(aptArgs, [
    '-o', 'Dir::Etc::sourcelist=' + listPath,
    '-o', 'Dir::Etc::sourceparts=' + partsPath,
    '-o', 'Acquire::http::Timeout=20', '-o', 'Acquire::https::Timeout=20', '-o', 'Acquire::Retries=1',
    ...(operation === 'update' ? ['update', '--error-on=any'] : ['install', '-y', 'xvfb', 'x11-utils']),
  ]);
  assert.deepEqual(fs.readdirSync(partsPath), []);
  for (const [path, mode] of [[listPath, 0o644], [partsPath, 0o755], [join(listPath, '..'), 0o755]]) {
    const stat = fs.statSync(path);
    assert.equal(stat.mode & 0o777, mode);
    assert.equal(stat.uid, process.getuid());
  }
  const attempt = calls.filter((entry) => entry.command === 'update').length;
  const result = operation === 'update'
    ? scenario.updates?.[attempt] ?? { status: 0, output: 'Reading package lists...\\n' }
    : scenario.install ?? { status: 0 };
  record({ command: operation, args: aptArgs, sources: fs.readFileSync(listPath, 'utf8'), listPath, status: result.status });
  process.stdout.write(result.output ?? '');
  if (operation === 'install' && result.status === 0) {
    for (const name of scenario.provided ?? ['xvfb-run', 'xdpyinfo']) provide(name);
  }
  process.exitCode = result.status;
} else {
  throw new Error('Unexpected system command: ' + command);
}
`;
  await fs.writeFile(join(bin, 'stub.mjs'), stub, { mode: 0o755 });
  for (const name of ['sudo', 'sleep', 'dpkg', 'timeout', 'apt-get']) {
    await fs.symlink('stub.mjs', join(bin, name));
  }
  // Only harmless filesystem utilities may delegate to the OS, within our fixture.
  for (const name of ['mktemp', 'mkdir', 'chmod', 'cat', 'rm']) {
    const location = spawnSync('/bin/bash', ['-c', `command -v ${name}`], {
      env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8',
    });
    assert.equal(location.status, 0, location.stderr);
    await fs.symlink(location.stdout.trim(), join(bin, name));
  }
  for (const name of options.installed ?? []) {
    assert.ok(['xvfb-run', 'xdpyinfo'].includes(name));
    await fs.writeFile(join(bin, name), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  }
  const fixtureScript = script
    .replace('PATH=/usr/sbin:/usr/bin:/sbin:/bin', `PATH='${bin}'`)
    .replace('/etc/os-release', `'${release}'`)
    .replaceAll(keyring, testKeyring)
    .replace('/tmp/openwork-apt.XXXXXXXX', `'${root}/apt.XXXXXXXX'`)
    .replaceAll('/usr/bin/dpkg', `'${bin}/dpkg'`)
    .replaceAll('/usr/bin/timeout', `'${bin}/timeout'`)
    .replaceAll('/usr/bin/apt-get', `'${bin}/apt-get'`);
  assert.doesNotMatch(fixtureScript, /\/usr\/bin\/(?:apt-get|sudo|timeout|dpkg)|\/etc\/os-release|\/tmp\/openwork-apt/);
  const result = spawnSync('/bin/bash', ['--noprofile', '--norc', '-euo', 'pipefail'], {
    input: fixtureScript,
    env: { PATH: bin, TEST_ROOT: root, APT_CONFIG: '/must-not-be-used.conf' },
    encoding: 'utf8', timeout: 15_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  const calls = JSON.parse(await fs.readFile(join(root, 'calls.json'), 'utf8'));
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.startsWith('apt.')), [], 'EXIT trap cleans sources and logs');
  for (const call of calls.filter((entry) => entry.sources)) {
    call.sources = call.sources.replaceAll(testKeyring, keyring);
    assert.equal(basename(call.listPath), 'sources.list');
  }
  return { ...result, calls, output: result.stdout + result.stderr };
}

test('skip APT only when both commands are installed', async (t) => {
  const result = await execute(t, { installed: ['xvfb-run', 'xdpyinfo'] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /skipping APT/);
});

for (const installed of [[], ['xvfb-run'], ['xdpyinfo']]) {
  test(`normal success installs with identical sources/options when initially installed: ${installed}`, async (t) => {
    const result = await execute(t, { installed });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.calls.map((call) => call.command), ['update', 'install']);
    for (const call of result.calls) assert.equal(call.sources, sources);
    assert.deepEqual(result.calls[0].args.slice(0, 10), result.calls[1].args.slice(0, 10));
    assert.match(result.output, /attempt 1\/3 source=security status=0/);
  });
}

test('transport retries use fresh APT calls, then change only the security host', async (t) => {
  const result = await execute(t, { updates: [failure(transport), failure(transport), { status: 0 }] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls.map((call) => call.command), ['update', 'sleep', 'update', 'sleep', 'update', 'install']);
  assert.deepEqual(result.calls.filter((call) => call.command === 'sleep').map((call) => call.args), [['5'], ['10']]);
  const aptCalls = result.calls.filter((call) => call.sources);
  const fallback = sources.replace('https://security.ubuntu.com', 'https://archive.ubuntu.com');
  assert.deepEqual(aptCalls.map((call) => call.sources), [sources, sources, fallback, fallback]);
  for (const call of aptCalls) assert.deepEqual(call.args.slice(0, 10), aptCalls[0].args.slice(0, 10));
  assert.match(result.output, /TLSWaitFd/);
  assert.match(result.output, /attempt 2\/3 source=security status=100/);
  assert.match(result.output, /attempt 3\/3 source=archive-security-fallback status=0/);
});

test('second attempt success does not use fallback', async (t) => {
  const result = await execute(t, { updates: [failure('Temporary failure resolving security.ubuntu.com'), { status: 0 }] });
  assert.equal(result.status, 0, result.output);
  assert.deepEqual(result.calls.map((call) => call.command), ['update', 'sleep', 'update', 'install']);
  for (const call of result.calls.filter((entry) => entry.sources)) assert.equal(call.sources, sources);
});

for (const status of [124, 137]) {
  test(`bounded timeout status ${status} retries before installing`, async (t) => {
    const result = await execute(t, { updates: [{ status }, { status: 0 }] });
    assert.equal(result.status, 0, result.output);
    assert.deepEqual(result.calls.map((call) => call.command), ['update', 'sleep', 'update', 'install']);
  });
}

for (const detail of [
  'Certificate verification failed: The certificate is NOT trusted.',
  'The following signatures could not be verified: NO_PUBKEY ABCDEF',
  'At least one invalid signature was encountered.',
  'The repository does not have a Release file.',
  'Malformed entry 1 in list file',
  'Conflicting values set for option Signed-By',
  'Hash Sum mismatch',
  '404 Not Found',
  'Unknown APT failure',
]) {
  test(`fatal/unknown error never retries or installs: ${detail}`, async (t) => {
    const result = await execute(t, { updates: [failure(detail)] });
    assert.equal(result.status, 100, result.output);
    assert.deepEqual(result.calls.map((call) => call.command), ['update']);
  });
}

test('transport or timeout never masks another fatal/unknown diagnostic', async (t) => {
  for (const status of [100, 124, 137]) {
    for (const diagnostic of ['E: Unknown configuration error', 'W: Unknown warning', 'Unknown diagnostic', 'Certificate verification failed']) {
      const result = await execute(t, { updates: [{ status, output: failure(transport).output + diagnostic + '\n' }] });
      assert.equal(result.status, status, result.output);
      assert.deepEqual(result.calls.map((call) => call.command), ['update']);
    }
  }
});

test('fatal error on a retry stops before fallback or install', async (t) => {
  const result = await execute(t, { updates: [failure(transport), failure('Certificate verification failed')] });
  assert.equal(result.status, 100, result.output);
  assert.deepEqual(result.calls.map((call) => call.command), ['update', 'sleep', 'update']);
});

test('exhaustion cannot install, even if fallback resolves to the same bad backend', async (t) => {
  const result = await execute(t, { updates: [failure(transport), failure(transport), failure(transport)] });
  assert.equal(result.status, 100, result.output);
  assert.deepEqual(result.calls.map((call) => call.command), ['update', 'sleep', 'update', 'sleep', 'update']);
});

test('unrecognized status or empty APT failure cannot retry or install', async (t) => {
  for (const update of [{ status: 100 }, { status: 1, output: transport }, { status: 125 }, { status: 126 }, { status: 127 }]) {
    const result = await execute(t, { updates: [update] });
    assert.equal(result.status, update.status, result.output);
    assert.deepEqual(result.calls.map((call) => call.command), ['update']);
  }
});

test('install errors/timeouts fail without blind dpkg retry', async (t) => {
  for (const status of [100, 124, 137]) {
    const result = await execute(t, { install: { status } });
    assert.equal(result.status, status, result.output);
    assert.deepEqual(result.calls.map((call) => call.command), ['update', 'install']);
  }
});

test('successful install must actually provide both commands', async (t) => {
  for (const provided of [[], ['xvfb-run'], ['xdpyinfo']]) {
    const result = await execute(t, { provided });
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /did not provide both required commands/);
    assert.deepEqual(result.calls.map((call) => call.command), ['update', 'install']);
  }
});

test('unexpected OS, suite, architecture or missing keyring fails before APT', async (t) => {
  for (const options of [
    { release: 'ID=debian\nVERSION_ID=22.04\nVERSION_CODENAME=jammy\n' },
    { release: 'ID=ubuntu\nVERSION_ID=24.04\nVERSION_CODENAME=noble\n' },
    { release: 'ID=ubuntu\nVERSION_ID=22.04\nVERSION_CODENAME=noble\n' },
    { release: '' },
    { architecture: 'arm64' },
    { noKeyring: true },
  ]) {
    const result = await execute(t, options);
    assert.equal(result.status, 1, result.output);
    assert.deepEqual(result.calls, []);
    assert.match(result.output, /requires Ubuntu 22.04\/jammy amd64/);
  }
});
