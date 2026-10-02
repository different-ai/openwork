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

// node:sqlite (the server's runtime database) is available without a flag
// from Node 22.13 and 23.4.
export const MIN_NODE_VERSION = "22.13.0";

export function nodeVersionSupported(version) {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  if (major === 22) return minor >= 13;
  if (major === 23) return minor >= 4;
  return major > 23;
}
