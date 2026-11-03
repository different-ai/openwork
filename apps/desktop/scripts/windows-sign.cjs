const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

// Native dependency packages can contain Mach-O/ELF .node prebuilds too.
// Detect PE by its headers, not by its filename or the build host's CPU.
function isPE(file) {
  const fd = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(64);
    if (fs.readSync(fd, header, 0, 64, 0) !== 64 || header.readUInt16LE(0) !== 0x5a4d) return false;
    const signature = Buffer.alloc(4);
    return fs.readSync(fd, signature, 0, 4, header.readUInt32LE(60)) === 4 && signature.readUInt32LE(0) === 0x4550;
  } finally {
    fs.closeSync(fd);
  }
}

function isNonWindowsNative(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const magic = Buffer.alloc(4);
    if (fs.readSync(fd, magic, 0, 4, 0) !== 4) return false;
    return [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(magic.readUInt32BE(0));
  } finally { fs.closeSync(fd); }
}

function sign(configuration, { env = process.env, execute = execFileSync } = {}) {
  // Keep the existing unsigned packaging path, including developer builds.
  if (env.SIGN_WINDOWS !== "true") return;
  if (!isPE(configuration.path)) {
    if (path.extname(configuration.path).toLowerCase() === ".node" && isNonWindowsNative(configuration.path)) return;
    throw new Error(`Refusing to sign a non-PE executable: ${path.basename(configuration.path)}`);
  }
  execute("pwsh", ["-NoProfile", "-NonInteractive", "-File",
    path.resolve(__dirname, "../../..", "scripts/release/windows-signatures.ps1"),
    "-Mode", "Sign", "-Path", configuration.path], { stdio: "inherit", env, timeout: 600_000 });
  // Builder deletes its generated uninstaller after embedding it in NSIS.
  // Retain the exact signed bytes so cross-packaged ARM64 builds can audit it too.
  if (configuration.path.endsWith('__uninstaller.exe')) {
    const evidence = path.join(path.dirname(configuration.path), 'signature-evidence');
    fs.mkdirSync(evidence, { recursive: true });
    fs.copyFileSync(configuration.path, path.join(evidence, 'uninstaller.exe'));
  }
}

module.exports = sign;
module.exports.default = sign;
module.exports.isPE = isPE;
