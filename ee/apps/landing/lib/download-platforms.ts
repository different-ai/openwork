import type { DownloadCardInstallers } from "@openwork/ui/react";

// Stable, versionless download URLs for agents and scripts:
//   https://openworklabs.com/download/<platform>
// Release asset names include the version (openwork-mac-arm64-0.18.54.dmg), so
// a literal GitHub URL goes stale every release. These slugs redirect to the
// current public installer resolved by getGithubData().
export const downloadPlatforms = {
  "mac-arm64": { label: "macOS (Apple Silicon) .dmg", pick: (i: DownloadCardInstallers) => i.macos.appleSilicon },
  "mac-x64": { label: "macOS (Intel) .dmg", pick: (i: DownloadCardInstallers) => i.macos.intel },
  "win-x64": { label: "Windows (x64) .exe", pick: (i: DownloadCardInstallers) => i.windows.x64 },
  "win-arm64": { label: "Windows (ARM64) .exe", pick: (i: DownloadCardInstallers) => i.windows.arm64 },
  "linux-x64": { label: "Linux (x64) .AppImage", pick: (i: DownloadCardInstallers) => i.linux.appImageX64 },
  "linux-arm64": { label: "Linux (ARM64) .AppImage", pick: (i: DownloadCardInstallers) => i.linux.appImageArm64 },
} satisfies Record<string, { label: string; pick: (installers: DownloadCardInstallers) => string }>;

export type DownloadPlatform = keyof typeof downloadPlatforms;

export function isDownloadPlatform(value: string): value is DownloadPlatform {
  return Object.hasOwn(downloadPlatforms, value);
}

export function downloadPlatformHref(installers: DownloadCardInstallers, platform: DownloadPlatform): string {
  return downloadPlatforms[platform].pick(installers);
}
