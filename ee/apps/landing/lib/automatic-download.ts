import type { DetectedPlatform, DownloadCardInstallers } from "@openwork/ui/react";

export function automaticDownloadHref(
  installers: DownloadCardInstallers,
  detected: DetectedPlatform | null,
  userAgent: string,
  maxTouchPoints: number
): string | null {
  // The shared card detector defaults unknown devices to macOS. That is not
  // safe for starting a download, including iPads using a desktop user agent.
  if (/android|iphone|ipad|ipod|mobile|cros/i.test(userAgent)) return null;
  if (/macintosh/i.test(userAgent) && maxTouchPoints > 1) return null;
  const os = /windows nt/i.test(userAgent) ? "windows"
    : /macintosh|mac os x/i.test(userAgent) ? "macos"
    : /linux/i.test(userAgent) ? "linux" : null;
  if (!os || detected?.os !== os || !detected.arch) return null;

  const arm = detected.arch === "arm64";
  const candidates = os === "macos"
    ? [arm ? installers.macos.appleSilicon : installers.macos.intel]
    : os === "windows"
      ? [installers.windows[detected.arch]]
      : arm
        ? [installers.linux.appImageArm64, installers.linux.tarArm64]
        : [installers.linux.appImageX64, installers.linux.tarX64];

  // Release-page fallbacks must stay visible choices, never hidden navigations.
  return candidates.find((href) => /\.(dmg|exe|appimage|tar\.gz)$/i.test(href)) ?? null;
}
