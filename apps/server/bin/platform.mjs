export const SERVER_BINARY_TARGETS = [
  { platform: "darwin", arch: "arm64", target: "bun-darwin-arm64" },
  { platform: "darwin", arch: "x64", target: "bun-darwin-x64" },
  { platform: "linux", arch: "arm64", target: "bun-linux-arm64" },
  { platform: "linux", arch: "x64", target: "bun-linux-x64" },
  { platform: "win32", arch: "arm64", target: "bun-windows-arm64" },
  { platform: "win32", arch: "x64", target: "bun-windows-x64" },
];

function findTarget(platform, arch) {
  return SERVER_BINARY_TARGETS.find((entry) => entry.platform === platform && entry.arch === arch) ?? null;
}

export function serverBinaryName(platform, arch) {
  const target = findTarget(platform, arch);
  if (!target) return null;
  return `openwork-server-${target.target}${platform === "win32" ? ".exe" : ""}`;
}

// Each host binary ships in its own npm package (the esbuild/Biome pattern):
// one package with all six binaries exceeds the npm registry's size limit.
// `openwork-server` lists these as optionalDependencies and npm installs only
// the one whose os/cpu match the machine.
export function serverPlatformPackageName(platform, arch) {
  const target = findTarget(platform, arch);
  if (!target) return null;
  return `openwork-server-${target.target.replace(/^bun-/, "")}`;
}
