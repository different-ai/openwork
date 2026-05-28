type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type Release = {
  draft?: boolean;
  prerelease?: boolean;
  html_url?: string;
  tag_name?: string;
  assets?: ReleaseAsset[];
};

type Repo = {
  stargazers_count?: number;
};

const FALLBACK_RELEASE = "https://github.com/different-ai/openwork/releases";

const formatCompact = (value: number) => {
  try {
    return new Intl.NumberFormat("en", {
      notation: "compact",
      maximumFractionDigits: 1
    }).format(value);
  } catch {
    return String(value);
  }
};

const selectAsset = (
  assets: ReleaseAsset[],
  extensions: string[],
  keywords: string[] = []
) => {
  const matches = assets.filter((asset) => {
    if (!asset?.name || !asset?.browser_download_url) return false;
    const name = asset.name.toLowerCase();
    const extensionMatch = extensions.some((ext) => name.endsWith(ext));
    const keywordMatch =
      keywords.length === 0 || keywords.some((key) => name.includes(key));
    return extensionMatch && keywordMatch;
  });

  if (matches.length === 0) return null;

  return (
    matches.find((asset) => asset.name?.toLowerCase().includes("adhoc")) ||
    matches.find((asset) => asset.name?.toLowerCase().includes("universal")) ||
    matches.find((asset) => asset.name?.toLowerCase().includes("aarch64")) ||
    matches.find((asset) => asset.name?.toLowerCase().includes("arm64")) ||
    matches[0]
  );
};

const fetchJson = async <T,>(url: string): Promise<T | null> => {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json"
      },
      next: { revalidate: 60 * 60 }
    });

    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

export const getGithubData = async () => {
  // /releases/latest always returns the most recent non-draft, non-prerelease
  // release regardless of how many alpha/prerelease builds exist.  This avoids
  // the paginated list being flooded by alpha tags pushing stable releases out
  // of the per_page window.
  const [repo, latestRelease, releases] = await Promise.all([
    fetchJson<Repo>("https://api.github.com/repos/different-ai/openwork"),
    fetchJson<Release>(
      "https://api.github.com/repos/different-ai/openwork/releases/latest"
    ),
    fetchJson<Release[]>(
      "https://api.github.com/repos/different-ai/openwork/releases?per_page=50"
    )
  ]);

  const stars =
    typeof repo?.stargazers_count === "number"
      ? formatCompact(repo.stargazers_count)
      : "—";

  const releaseList = Array.isArray(releases) ? releases : [];
  const isElectronDesktopAsset = (name: string) =>
    name.startsWith("openwork-mac-") ||
    name.startsWith("openwork-win-") ||
    name.startsWith("openwork-linux-");

  const hasElectronDesktopAsset = (release: Release) => {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    return assets.some((asset) => {
      const name = String(asset?.name || "").toLowerCase();
      return isElectronDesktopAsset(name);
    });
  };

  const hasWindowsDesktopAsset = (release: Release) => {
    const assets = Array.isArray(release?.assets) ? release.assets : [];
    return assets.some((asset) => {
      const name = String(asset?.name || "").toLowerCase();
      return name.startsWith("openwork-win-x64-") && name.endsWith(".exe");
    });
  };

  const isStableDesktopRelease = (release: Release) => {
    if (!release || release.draft || release.prerelease) return false;
    const tag = String(release.tag_name || "").trim();
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) return false;
    return hasElectronDesktopAsset(release);
  };

  // Prefer the /releases/latest result (immune to alpha flood), then fall back
  // to scanning the paginated list for a stable release with desktop assets.
  const pick =
    (latestRelease && hasElectronDesktopAsset(latestRelease) ? latestRelease : null) ||
    releaseList.find((release) => isStableDesktopRelease(release)) ||
    (latestRelease ?? null);

  const windowsPick =
    (latestRelease && hasWindowsDesktopAsset(latestRelease) ? latestRelease : null) ||
    releaseList.find((release) => isStableDesktopRelease(release) && hasWindowsDesktopAsset(release));

  const assets = Array.isArray(pick?.assets) ? pick.assets : [];
  const releaseUrl = pick?.html_url || FALLBACK_RELEASE;
  const windowsAssets = Array.isArray(windowsPick?.assets) ? windowsPick.assets : assets;
  const windowsReleaseUrl = windowsPick?.html_url || releaseUrl;
  const dmg = selectAsset(assets, [".dmg"], ["openwork-mac-"]);
  const exe = selectAsset(windowsAssets, [".exe"], ["openwork-win-"]);
  const macosApple = selectAsset(assets, [".dmg"], ["mac-arm64"]);
  const macosIntel = selectAsset(assets, [".dmg"], ["mac-x64"]);
  const windowsX64 =
    selectAsset(windowsAssets, [".exe"], ["win-x64"]) || exe;

  const linuxAppImageX64 =
    selectAsset(assets, [".appimage"], ["linux-x86_64"]) ||
    selectAsset(assets, [".appimage"], ["linux-x64"]);
  const linuxAppImageArm64 = selectAsset(assets, [".appimage"], ["linux-arm64"]);
  const linuxTarX64 = selectAsset(assets, [".tar.gz"], ["linux-x64"]);
  const linuxTarArm64 = selectAsset(assets, [".tar.gz"], ["linux-arm64"]);

  return {
    stars,
    releaseUrl,
    releaseTag: pick?.tag_name || "",
    downloads: {
      macos: dmg?.browser_download_url || FALLBACK_RELEASE,
      windows: exe?.browser_download_url || FALLBACK_RELEASE,
      linux:
        linuxAppImageX64?.browser_download_url ||
        linuxTarX64?.browser_download_url ||
        FALLBACK_RELEASE
    },
    installers: {
      macos: {
        appleSilicon: macosApple?.browser_download_url || dmg?.browser_download_url || releaseUrl,
        intel: macosIntel?.browser_download_url || dmg?.browser_download_url || releaseUrl
      },
      windows: {
        x64: windowsX64?.browser_download_url || windowsReleaseUrl
      },
      linux: {
        appImageX64: linuxAppImageX64?.browser_download_url || releaseUrl,
        appImageArm64: linuxAppImageArm64?.browser_download_url || releaseUrl,
        tarX64: linuxTarX64?.browser_download_url || releaseUrl,
        tarArm64: linuxTarArm64?.browser_download_url || releaseUrl
      }
    }
  };
};
