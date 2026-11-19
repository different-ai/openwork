import { denBrowserEndpoint } from "./den-api-origin";

export type InstallPlatform = "mac-arm64" | "mac-x64" | "win-x64" | "linux-x64" | "linux-arm64";
export type DetectedInstallerOs = "macos" | "windows" | "linux";
export type DetectedInstallerArch = "arm64" | "x64";
export type DetectedInstallerPlatform = {
  os: DetectedInstallerOs;
  arch: DetectedInstallerArch | null;
};

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

/** The normal install page; people sign in there and get their own organization's setup. */
export function installPageUrl() {
  return new URL("/install", window.location.origin).toString();
}

/** Downloads the desktop app approved for the signed-in member's active organization. */
export function installDownloadHref(platform: InstallPlatform) {
  return denBrowserEndpoint(`/v1/me/install/${platform}`);
}

export function detectedInstallPlatform(detected: DetectedInstallerPlatform | null): InstallPlatform | null {
  if (!detected) return null;
  if (detected.os === "windows") return "win-x64";
  if (detected.os === "macos" && detected.arch === "arm64") return "mac-arm64";
  if (detected.os === "macos" && detected.arch === "x64") return "mac-x64";
  if (detected.os === "linux" && detected.arch === "arm64") return "linux-arm64";
  if (detected.os === "linux") return "linux-x64";
  if (detected.os === "macos") return "mac-arm64";
  return null;
}

export function downloadCtaLabel(os: DetectedInstallerOs | null) {
  if (os === "windows") return "Download for Windows";
  if (os === "linux") return "Download for Linux";
  return "Download for macOS";
}
