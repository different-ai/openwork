export const SERVER_NPM_META_PACKAGE = "openwork-server";

export const SERVER_NPM_TARGETS = Object.freeze([
  Object.freeze({ id: "darwin-arm64", bun: "bun-darwin-arm64", os: "darwin", cpu: "arm64" }),
  Object.freeze({ id: "darwin-x64", bun: "bun-darwin-x64", os: "darwin", cpu: "x64" }),
  Object.freeze({ id: "linux-x64", bun: "bun-linux-x64", os: "linux", cpu: "x64" }),
  Object.freeze({ id: "linux-arm64", bun: "bun-linux-arm64", os: "linux", cpu: "arm64" }),
  Object.freeze({ id: "windows-x64", bun: "bun-windows-x64", os: "win32", cpu: "x64" }),
  Object.freeze({ id: "windows-arm64", bun: "bun-windows-arm64", os: "win32", cpu: "arm64" }),
]);

export function serverPlatformPackageName(target) {
  return `${SERVER_NPM_META_PACKAGE}-${target.id}`;
}

export function serverPlatformBinaryName(target) {
  return target.os === "win32" ? "openwork-server.exe" : "openwork-server";
}

export function serverBuildBinaryName(target) {
  const extension = target.os === "win32" ? ".exe" : "";
  return `openwork-server-${target.bun}${extension}`;
}

export function currentServerTarget(platform = process.platform, arch = process.arch) {
  return SERVER_NPM_TARGETS.find((target) => target.os === platform && target.cpu === arch) ?? null;
}

export function serverOptionalDependencies(version) {
  return Object.fromEntries(
    SERVER_NPM_TARGETS.map((target) => [serverPlatformPackageName(target), version]),
  );
}
