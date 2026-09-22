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
