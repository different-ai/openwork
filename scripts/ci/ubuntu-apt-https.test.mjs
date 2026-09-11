import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { rewriteAptSources, transformSources } from './ubuntu-apt-https.mjs';

const source = 'deb http://archive.ubuntu.com/ubuntu jammy main\n';
const secureSource = 'deb https://archive.ubuntu.com/ubuntu jammy main\n';

test('legacy sources preserve options, suites, paths, comments and line endings', () => {
  const input = [
    '# deb http://archive.ubuntu.com/ubuntu jammy main',
    ' deb [arch=amd64 signed-by=/usr/share/keyrings/ubuntu.gpg] http://archive.ubuntu.com/ubuntu/ jammy-updates main restricted # http://archive.ubuntu.com/unchanged',
    'deb-src\thttp://us.archive.ubuntu.com/custom/path/ jammy universe',
    'deb http://security.ubuntu.com/ubuntu jammy-security main',
    'deb [signed-by=http://archive.ubuntu.com/key] https://archive.ubuntu.com/ubuntu jammy main',
    'deb mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt jammy main',
    '',
  ].join('\r\n');
  const expected = input
    .replace('] http://archive.ubuntu.com/ubuntu/', '] https://archive.ubuntu.com/ubuntu/')
    .replace('deb-src\thttp:', 'deb-src\thttps:')
    .replace('deb http://security.', 'deb https://security.');
  assert.equal(transformSources(input, 'list'), expected);
  assert.equal(transformSources(expected, 'list'), expected);
});

test('Deb822 rewrites multiple URIs and continuations, not Signed-By or other fields', () => {
  const input = [
    'Types: deb deb-src',
    'URIs: http://archive.ubuntu.com/ubuntu http://us.archive.ubuntu.com/ubuntu/',
    ' http://security.ubuntu.com/ubuntu',
    '# comment does not end the URIs field: http://archive.ubuntu.com/ubuntu',
    '\thttp://archive.ubuntu.com/another/path # http://archive.ubuntu.com/comment',
    ' mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt',
    'Suites: jammy jammy-updates',
    'Components: main universe',
    'Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg',
    'X-Comment: http://archive.ubuntu.com/leave-alone',
    '',
    'Types: deb',
    'uris:',
    ' http://security.ubuntu.com/ubuntu',
    'Suites: jammy-security',
    'Signed-By:',
    ' -----BEGIN PGP PUBLIC KEY BLOCK-----',
    ' .',
    ' http://archive.ubuntu.com/not-a-uri-field',
    ' -----END PGP PUBLIC KEY BLOCK-----',
    '',
    ' http://archive.ubuntu.com/not-a-continuation',
    '',
    'Types: deb',
    'URIs:http://archive.ubuntu.com/ubuntu',
    'Suites: jammy',
  ].join('\r\n');
  const expected = input
    .replace('URIs: http:', 'URIs: https:')
    .replace(' http://us.archive.', ' https://us.archive.')
    .replaceAll(' http://security.', ' https://security.')
    .replace('\thttp://archive.', '\thttps://archive.')
    .replace('URIs:http:', 'URIs:https:');
  assert.equal(transformSources(input, 'sources'), expected);
  assert.equal(transformSources(expected, 'sources'), expected);
});

test('only the three exact official HTTP authorities are upgraded in every format', () => {
  const untouched = [
    'http://archive.ubuntu.com.example.org/ubuntu',
    'http://example.org/archive.ubuntu.com/ubuntu',
    'http://archive.ubuntu.com@example.org/ubuntu',
    'http://user@archive.ubuntu.com/ubuntu',
    'http://archive.ubuntu.com:80/ubuntu',
    'http://archive.ubuntu.com./ubuntu',
    'http://archive.ubuntu.com?other=/ubuntu',
    'http://azure.archive.ubuntu.com/ubuntu',
    'http://ports.ubuntu.com/ubuntu-ports',
    'http://gb.archive.ubuntu.com/ubuntu',
    'http://ppa.launchpad.net/example/ubuntu',
    'http://mirrors.sonic.net/ubuntu',
    'https://archive.ubuntu.com/ubuntu',
    'mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt',
  ];
  for (const uri of untouched) {
    for (const [format, input] of [
      ['list', `deb ${uri} jammy main`],
      ['sources', `Types: deb\nURIs: ${uri}\nSuites: jammy`],
      ['mirrors', `${uri}\tpriority:1 # keep`],
    ]) assert.equal(transformSources(input, format), input, `${format}: ${uri}`);
  }
});

test('mirror list retains metadata and comments and only comments the exact Sonic HTTP entry', () => {
  const input = [
    '# http://archive.ubuntu.com/ubuntu',
    ' http://mirrors.sonic.net/ubuntu\tpriority:1 # observed',
    'http://mirrors.sonic.net/ubuntu/\tpriority:2',
    'http://us.archive.ubuntu.com/ubuntu/\tpriority:3 arch:amd64',
    'http://security.ubuntu.com/ubuntu\tpriority:4 codename:jammy',
    'http://mirrors.sonic.net/ubuntu-other',
    'http://mirrors.sonic.net/ubuntu/pool',
    'http://mirrors.sonic.net/other/ubuntu',
    'http://mirrors.sonic.net/ubuntu?query=1',
    'http://mirrors.sonic.net:80/ubuntu',
    'http://mirrors.sonic.net.example.org/ubuntu',
    'https://mirrors.sonic.net/ubuntu',
    'http://another-mirror.example.org/ubuntu\tpriority:5',
    '',
  ].join('\n');
  const expected = input
    .replace(' http://mirrors.sonic.net/ubuntu\t', '#  http://mirrors.sonic.net/ubuntu\t')
    .replace('\nhttp://mirrors.sonic.net/ubuntu/\t', '\n# http://mirrors.sonic.net/ubuntu/\t')
    .replace('http://us.archive.', 'https://us.archive.')
    .replace('http://security.', 'https://security.');
  assert.equal(transformSources(input, 'mirrors'), expected);
  assert.equal(transformSources(expected, 'mirrors'), expected);
});

test('Sonic stays when no usable official HTTPS Ubuntu candidate remains', () => {
  for (const candidate of [
    '',
    '# https://archive.ubuntu.com/ubuntu',
    'https://archive.ubuntu.com.example.org/ubuntu',
    'https://archive.ubuntu.com/other',
    'https://archive.ubuntu.com/ubuntu/pool',
    'https://user@archive.ubuntu.com/ubuntu',
    'https://archive.ubuntu.com:443/ubuntu',
    'https://another-mirror.example.org/ubuntu',
  ]) {
    const input = `http://mirrors.sonic.net/ubuntu\tpriority:1\n${candidate}\n`;
    assert.equal(transformSources(input, 'mirrors'), input);
  }
  const input = 'http://mirrors.sonic.net/ubuntu\nhttps://archive.ubuntu.com/ubuntu\n';
  assert.equal(transformSources(input, 'mirrors'), `# ${input}`);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ubuntu-apt-https-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('I/O visits only the fixed files and immediate .list/.sources children; preserves metadata', async (t) => {
  const directory = await fixture(t);
  const sourcesDirectory = join(directory, 'sources.list.d');
  await fs.mkdir(join(sourcesDirectory, 'nested'), { recursive: true });
  const contents = new Map([
    ['sources.list', 'deb mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt jammy main\n'],
    ['blacksmith-ubuntu-mirrors.txt', 'http://mirrors.sonic.net/ubuntu\nhttp://archive.ubuntu.com/ubuntu\n'],
    ['sources.list.d/ubuntu.list', source],
    ['sources.list.d/ubuntu.sources', 'Types: deb\nURIs:\n http://security.ubuntu.com/ubuntu\nSuites: jammy-security\n'],
    ['sources.list.d/unchanged.list', 'deb mirror+file:/etc/apt/blacksmith-ubuntu-mirrors.txt jammy main\n'],
    ['sources.list.d/ignored.list.save', source],
    ['sources.list.d/nested/ignored.list', source],
    ['apt-mirrors.txt', 'http://mirrors.sonic.net/ubuntu\nhttp://archive.ubuntu.com/ubuntu\n'],
    ['auth.conf', 'machine archive.ubuntu.com login fixture password fixture\n'],
  ]);
  const stats = new Map();
  for (const [name, content] of contents) {
    const path = join(directory, name);
    await fs.writeFile(path, content);
    await fs.chmod(path, 0o640);
    await fs.utimes(path, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
    stats.set(name, await fs.stat(path));
  }
  const changed = ['blacksmith-ubuntu-mirrors.txt', 'sources.list.d/ubuntu.list', 'sources.list.d/ubuntu.sources'];
  assert.deepEqual(await rewriteAptSources(directory), changed.map((name) => join(directory, name)));
  assert.equal(await fs.readFile(join(directory, 'blacksmith-ubuntu-mirrors.txt'), 'utf8'),
    '# http://mirrors.sonic.net/ubuntu\nhttps://archive.ubuntu.com/ubuntu\n');
  for (const [name, content] of contents) {
    const path = join(directory, name);
    const before = stats.get(name);
    const after = await fs.stat(path);
    for (const key of ['mode', 'uid', 'gid', 'ino']) assert.equal(after[key], before[key], `${name}: ${key}`);
    const format = name === 'blacksmith-ubuntu-mirrors.txt' ? 'mirrors' : name.endsWith('.sources') ? 'sources' : 'list';
    assert.equal(await fs.readFile(path, 'utf8'), changed.includes(name) ? transformSources(content, format) : content);
    if (!changed.includes(name)) assert.equal(after.mtimeMs, before.mtimeMs);
    stats.set(name, after);
  }
  assert.deepEqual(await rewriteAptSources(directory), []);
  for (const [name, before] of stats) assert.equal((await fs.stat(join(directory, name))).mtimeMs, before.mtimeMs);
});

test('missing optional files and sources directory are okay; nothing is created', async (t) => {
  const directory = await fixture(t);
  assert.deepEqual(await rewriteAptSources(directory), []);
  assert.deepEqual(await fs.readdir(directory), []);
  await fs.mkdir(join(directory, 'sources.list.d'));
  await fs.writeFile(join(directory, 'sources.list.d/ubuntu.list'), source);
  assert.deepEqual(await rewriteAptSources(directory), [join(directory, 'sources.list.d/ubuntu.list')]);
  assert.equal(await fs.readFile(join(directory, 'sources.list.d/ubuntu.list'), 'utf8'), secureSource);
  assert.deepEqual((await fs.readdir(directory)).sort(), ['sources.list.d']);
});

test('symlinked source files and directories fail without touching their targets', async (t) => {
  const directory = await fixture(t);
  const target = join(directory, 'target');
  await fs.writeFile(target, source);
  for (const name of ['sources.list', 'blacksmith-ubuntu-mirrors.txt', 'sources.list.d']) {
    const path = join(directory, name);
    await fs.symlink(target, path);
    await assert.rejects(rewriteAptSources(directory));
    assert.equal(await fs.readFile(target, 'utf8'), source);
    await fs.unlink(path);
  }
  await fs.mkdir(join(directory, 'sources.list.d'));
  await fs.symlink(target, join(directory, 'sources.list.d/ubuntu.sources'));
  await assert.rejects(rewriteAptSources(directory));
  assert.equal(await fs.readFile(target, 'utf8'), source);
  const alias = join(directory, 'alias');
  await fs.symlink(directory, alias);
  await assert.rejects(rewriteAptSources(alias), /Expected a real directory/);
});

test('non-regular files and hard links fail without modifying data', async (t) => {
  const directory = await fixture(t);
  const path = join(directory, 'sources.list');
  await fs.mkdir(path);
  await assert.rejects(rewriteAptSources(directory));
  await fs.rmdir(path);
  const target = join(directory, 'target');
  await fs.writeFile(target, source);
  await fs.link(target, path);
  await assert.rejects(rewriteAptSources(directory), /regular file/);
  assert.equal(await fs.readFile(target, 'utf8'), source);
});

test('write errors propagate, including permission errors, with no APT or root access', async (t) => {
  const directory = await fixture(t);
  const path = join(directory, 'sources.list');
  await fs.writeFile(path, source);
  const open = fs.open;
  const writeError = Object.assign(new Error('fixture write failure'), { code: 'EIO' });
  const mock = t.mock.method(fs, 'open', async (...args) => {
    const handle = await open(...args);
    t.mock.method(handle, 'write', async () => { throw writeError; });
    return handle;
  });
  await assert.rejects(rewriteAptSources(directory), (error) => error === writeError);
  mock.mock.restore();
  const permissionError = Object.assign(new Error('fixture access failure'), { code: 'EACCES' });
  t.mock.method(fs, 'open', async () => { throw permissionError; });
  await assert.rejects(rewriteAptSources(directory), (error) => error === permissionError);
  assert.equal(await fs.readFile(path, 'utf8'), source);
});
