const fs = require("node:fs");
const path = require("node:path");

// electron-builder's PackContext uses builder-util's numeric Arch enum.
function nativeTarget(platform, arch) {
  const architecture = arch === 1 ? "x64" : arch === 3 ? "arm64" : arch;
  if (!["darwin", "linux", "win32"].includes(platform) || !["x64", "arm64"].includes(architecture)) {
    throw new Error(`Unsupported desktop native target: ${platform}/${arch}`);
  }
  return { platform, arch: architecture };
}

function verifyNativeModules(files, platform, arch, unpackedRoot) {
  const target = nativeTarget(platform, arch);
  const sqliteNames = target.platform === "linux"
    ? [`linux-${target.arch}.node`, `linuxmusl-${target.arch}.node`]
    : [`${target.platform}-${target.arch}.node`];
  const sqliteRoots = new Map();
  const ptyFiles = [];
  for (const entry of files) {
    const file = entry.replaceAll("\\", "/").replace(/^\//, "");
    const sqlite = /^(.*\/better-sqlite3)\/prebuilds\/([^/]+\.node)$/.exec(file);
    if (sqlite) {
      if (!sqliteNames.includes(sqlite[2])) throw new Error(`Foreign SQLite native module: ${file}`);
      if (!sqliteRoots.has(sqlite[1])) sqliteRoots.set(sqlite[1], new Set());
      sqliteRoots.get(sqlite[1]).add(sqlite[2]);
    }
    // Include manifests so a package with all its natives missing also fails.
    if (file.endsWith("/better-sqlite3/package.json")) {
      const root = file.slice(0, -"/package.json".length);
      if (!sqliteRoots.has(root)) sqliteRoots.set(root, new Set());
    }
    const pty = /\/@lydell\/node-pty-([^/]+)\//.exec(file);
    if (pty && pty[1] !== `${target.platform}-${target.arch}`) {
      throw new Error(`Foreign PTY package: ${file}`);
    }
    if (pty && file.endsWith(".node")) ptyFiles.push(file);
    if ((sqlite || pty && file.endsWith(".node")) && !fs.existsSync(path.join(unpackedRoot, file))) {
      throw new Error(`Missing unpacked native module: ${file}`);
    }
  }
  if (sqliteRoots.size === 0) throw new Error("Missing packaged better-sqlite3");
  for (const [root, names] of sqliteRoots) {
    for (const name of sqliteNames) {
      if (!names.has(name)) throw new Error(`Missing target SQLite native module: ${root}/prebuilds/${name}`);
    }
  }
  const requiredPty = target.platform === "win32" ? ["conpty.node", "conpty_console_list.node"] : ["pty.node"];
  for (const name of requiredPty) {
    if (!ptyFiles.some((file) => path.posix.basename(file) === name)) {
      throw new Error(`Missing target PTY native module: ${target.platform}-${target.arch}/${name}`);
    }
  }
}

module.exports = { nativeTarget, verifyNativeModules };
