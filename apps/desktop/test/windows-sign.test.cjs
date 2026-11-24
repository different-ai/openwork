const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sign = require('../scripts/windows-sign.cjs');

function fixture(t, name, bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-sign-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  return file;
}
function pe() {
  const bytes = Buffer.alloc(256);
  bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128);
  return bytes;
}
test('unsigned builds do not inspect or sign files', () => {
  sign({ path: 'does-not-exist.exe' }, { env: {}, execute() { assert.fail('unsigned build signed'); } });
});
test('PE detection checks both headers, independent of filename and CPU', t => {
  assert.equal(sign.isPE(fixture(t, 'native.node', pe())), true);
  assert.equal(sign.isPE(fixture(t, 'metadata.exe', Buffer.from('{}'))), false);
  const broken = pe(); broken.writeUInt32LE(0xffffffff, 60);
  assert.equal(sign.isPE(fixture(t, 'broken.dll', broken)), false);
});
test('signed builds use the same PowerShell lifecycle hook for each PE', t => {
  for (const name of ['OpenWork.exe', 'Uninstall OpenWork.exe', 'elevate.exe', 'ffmpeg.dll', 'conpty.node']) {
    const file = fixture(t, name, pe()); let calls = 0;
    sign({ path: file }, { env: { SIGN_WINDOWS: 'true' }, execute(command, args, options) {
      calls++; assert.equal(command, 'pwsh');
      assert.equal(args.at(-1), file); assert.equal(args.at(-3), 'Sign');
      assert.equal(args[3], path.resolve(__dirname, '../../../scripts/release/windows-signatures.ps1'));
      assert.equal(fs.existsSync(args[3]), true, 'signer must resolve inside this checkout');
      assert.equal(options.env.SIGN_WINDOWS, 'true');
    }});
    assert.equal(calls, 1);
  }
});
test('retains the exact signed NSIS uninstaller before builder deletes it', t => {
  const file = fixture(t, 'app.__uninstaller.exe', pe());
  sign({ path: file }, { env: { SIGN_WINDOWS: 'true' }, execute() {} });
  assert.deepEqual(fs.readFileSync(path.join(path.dirname(file), 'signature-evidence/uninstaller.exe')), fs.readFileSync(file));
});
test('non-Windows native prebuilds are not signed, but JSON .exe is rejected', t => {
  for (const magic of [[0x7f, 0x45, 0x4c, 0x46], [0xcf, 0xfa, 0xed, 0xfe]]) {
    sign({ path: fixture(t, 'unix.node', Buffer.from(magic)) }, { env: { SIGN_WINDOWS: 'true' }, execute() { assert.fail(); } });
  }
  assert.throws(() => sign({ path: fixture(t, 'corrupt.node', Buffer.from('invalid')) }, { env: { SIGN_WINDOWS: 'true' } }), /non-PE/);
  assert.throws(() => sign({ path: fixture(t, 'versions.json.exe', Buffer.from('{}')) }, { env: { SIGN_WINDOWS: 'true' } }), /non-PE/);
});
test('hook propagates signing failures instead of silently shipping unsigned files', t => {
  assert.throws(() => sign({ path: fixture(t, 'app.exe', pe()) }, { env: { SIGN_WINDOWS: 'true' }, execute() { throw Error('signing failed'); } }), /signing failed/);
});
