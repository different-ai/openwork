import type { DownloadCardInstallers } from "@openwork/ui/react";

const FALLBACK_RELEASE = "https://github.com/different-ai/openwork/releases";

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type Release = {
  tag_name?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
};

// The same release carries the retired helper installers and the parallel
// Cloud and enterprise flavors. All can match the loose per-architecture
// keywords below and sort ahead of the public asset, so exclude them here
// exactly as the landing page does.
function isNonPublicDesktopAsset(name: string) {
  return name.startsWith("openwork-installer-")
    || name.startsWith("openwork-cloud-")
    || name.startsWith("openwork-enterprise-");
}

function selectAsset(assets: ReleaseAsset[], extensions: string[], keywords: string[]) {
  const loweredExtensions = extensions.map((value) => value.toLowerCase());
  const loweredKeywords = keywords.map((value) => value.toLowerCase());
  return (
    assets.find((asset) => {
      const name = String(asset.name || "").toLowerCase();
      return (
        loweredExtensions.some((extension) => name.endsWith(extension)) &&
        loweredKeywords.every((keyword) => name.includes(keyword)) &&
        !isNonPublicDesktopAsset(name)
      );
    }) ?? null
  );
}

/**
 * Public desktop installers for the onboarding download card. Same asset rules
 * as the landing page: never return gated org installers.
 */
export async function getPublicInstallers(): Promise<{
  installers: DownloadCardInstallers;
  releaseTag: string;
}> {
  try {
    const response = await fetch("https://api.github.com/repos/different-ai/openwork/releases/latest", {
      next: { revalidate: 3600 },
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      return { installers: fallbackInstallers(), releaseTag: "" };
    }
    const release = (await response.json()) as Release;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const releaseUrl = release.html_url || FALLBACK_RELEASE;
    const dmg = selectAsset(assets, [".dmg"], ["openwork-mac-"]);
    return {
      releaseTag: typeof release.tag_name === "string" ? release.tag_name : "",
      installers: {
        macos: {
          appleSilicon: selectAsset(assets, [".dmg"], ["mac-arm64"])?.browser_download_url || dmg?.browser_download_url || releaseUrl,
          intel: selectAsset(assets, [".dmg"], ["mac-x64"])?.browser_download_url || dmg?.browser_download_url || releaseUrl,
        },
        windows: {
          x64: selectAsset(assets, [".exe"], ["win-x64"])?.browser_download_url || releaseUrl,
          arm64: selectAsset(assets, [".exe"], ["win-arm64"])?.browser_download_url || releaseUrl,
        },
        linux: {
          appImageX64:
            selectAsset(assets, [".appimage"], ["linux-x86_64"])?.browser_download_url ||
            selectAsset(assets, [".appimage"], ["linux-x64"])?.browser_download_url ||
            releaseUrl,
          appImageArm64: selectAsset(assets, [".appimage"], ["linux-arm64"])?.browser_download_url || releaseUrl,
          tarX64: selectAsset(assets, [".tar.gz"], ["linux-x64"])?.browser_download_url || releaseUrl,
          tarArm64: selectAsset(assets, [".tar.gz"], ["linux-arm64"])?.browser_download_url || releaseUrl,
        },
      },
    };
  } catch {
    return { installers: fallbackInstallers(), releaseTag: "" };
  }
}

function fallbackInstallers(): DownloadCardInstallers {
  return {
    macos: { appleSilicon: FALLBACK_RELEASE, intel: FALLBACK_RELEASE },
    windows: { x64: FALLBACK_RELEASE, arm64: FALLBACK_RELEASE },
    linux: {
      appImageX64: FALLBACK_RELEASE,
      appImageArm64: FALLBACK_RELEASE,
      tarX64: FALLBACK_RELEASE,
      tarArm64: FALLBACK_RELEASE,
    },
  };
}
