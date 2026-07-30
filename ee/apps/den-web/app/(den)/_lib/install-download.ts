export type InstallPlatform = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64" | "linux-arm64";

export function installerFileName(platform: InstallPlatform | null, version: string) {
  if (!platform || !version.trim()) return null;
  if (platform === "mac-arm64" || platform === "mac-x64") {
    return `openwork-enterprise-${platform}-${version}.dmg`;
  }
  if (platform === "win-x64") {
    return `openwork-enterprise-${platform}-${version}.exe`;
  }
  if (platform === "linux-x64") {
    return `openwork-enterprise-linux-x86_64-${version}.AppImage`;
  }
  return `openwork-enterprise-linux-arm64-${version}.AppImage`;
}

export function cloudInstallerFileName(platform: InstallPlatform | null, version: string) {
  return installerFileName(platform, version)?.replace(/^openwork-enterprise-/, "openwork-cloud-") ?? null;
}

export function buildInstallDownloadHref(apiUrl: string, platform: InstallPlatform, token: string) {
  const url = new URL(apiUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  url.pathname = `${basePath}/v1/install/${platform}`;
  url.search = `?token=${encodeURIComponent(token)}`;
  url.hash = "";
  return url.toString();
}
