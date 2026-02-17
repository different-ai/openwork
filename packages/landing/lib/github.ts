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
  const [repo, releases] = await Promise.all([
    fetchJson<Repo>("https://api.github.com/repos/different-ai/openwork"),
    fetchJson<Release[]>(
      "https://api.github.com/repos/different-ai/openwork/releases?per_page=10"
    )
  ]);

  const stars =
    typeof repo?.stargazers_count === "number"
      ? formatCompact(repo.stargazers_count)
      : "—";

  const releaseList = Array.isArray(releases) ? releases : [];

  const isStableDesktopRelease = (release: Release) => {
    if (!release || release.draft || release.prerelease) return false;
    const tag = String(release.tag_name || "").trim();
    if (!/^v\d+\.\d+\.\d+([.-][0-9A-Za-z.-]+)?$/.test(tag)) return false;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    return assets.some((asset) => {
      const name = String(asset?.name || "").toLowerCase();
      return name.startsWith("openwork-desktop-");
    });
  };

  const pick =
    releaseList.find((release) => isStableDesktopRelease(release)) ||
    releaseList.find((release) => {
      if (!release || release.draft) return false;
      const assets = Array.isArray(release.assets) ? release.assets : [];
      return assets.some((asset) => asset?.browser_download_url);
    });

  const assets = Array.isArray(pick?.assets) ? pick.assets : [];
  const dmg = selectAsset(assets, [".dmg"]);
  const exe = selectAsset(assets, [".exe", ".msi"], ["win", "windows"]);
  const appImage = selectAsset(assets, [".appimage"], ["linux"]);

  return {
    stars,
    releaseUrl: pick?.html_url || FALLBACK_RELEASE,
    downloads: {
      macos: dmg?.browser_download_url || FALLBACK_RELEASE,
      windows: exe?.browser_download_url || FALLBACK_RELEASE,
      linux: appImage?.browser_download_url || FALLBACK_RELEASE
    }
  };
};
