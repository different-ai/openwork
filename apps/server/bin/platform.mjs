// Compiled Bun binaries built by `build:bin` / `build:bin:all` in a source
// checkout. The npm package does not ship them: it runs the Node bundle in
// dist/openwork-server.mjs, which works on every OS and CPU.
export const SERVER_BINARY_TARGETS = [
  { platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
  { platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
  { platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
  { platform: "linux", arch: "x64", target: "bun-linux-x64" },
  { platform: "win32", arch: "arm64", target: "bun-windows-arm64" },
  { platform: "win32", arch: "x64", target: "bun-windows-x64" },
];

export function serverBinaryName(platform, arch) {
  const target = SERVER_BINARY_TARGETS.find((entry) => entry.platform === platform && entry.arch === arch);
  if (!target) return null;
  return `openwork-server-${target.target}${platform === "win32" ? ".exe" : ""}`;
}

// Security baseline: only patched releases on the supported Node 24 line.
// New majors must be reviewed explicitly, not accepted by a lower-bound check.
export const MIN_NODE_VERSION = "24.22.1";

export function nodeVersionSupported(version) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 24 && (minor > 22 || (minor === 22 && patch >= 1));
}
