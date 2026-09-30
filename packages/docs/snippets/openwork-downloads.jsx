export const OpenWorkDownloads = () => {
  const STABLE_RELEASES_URL = "https://api.github.com/repos/different-ai/openwork/releases?per_page=30";
  const ALPHA_RELEASE_URL = "https://api.github.com/repos/different-ai/openwork/releases/tags/alpha-macos-latest";
  const GITHUB_HEADERS = { Accept: "application/vnd.github+json" };
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const buildTimeFormatter = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  const [activeChannel, setActiveChannel] = useState("stable");
  const [stableReleases, setStableReleases] = useState([]);
  const [stableLoading, setStableLoading] = useState(true);
  const [stableError, setStableError] = useState("");
  const [stableVisibleCount, setStableVisibleCount] = useState(8);
  const [alphaBuilds, setAlphaBuilds] = useState([]);
  const [alphaLoading, setAlphaLoading] = useState(false);
  const [alphaError, setAlphaError] = useState("");
  const [alphaRequested, setAlphaRequested] = useState(false);
  const [alphaVisibleCount, setAlphaVisibleCount] = useState(12);

  const formatSize = (bytes) => `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
  const formatDate = (date) => dateFormatter.format(new Date(date));
  const getAlphaMetadata = (asset) => {
    // Written by alpha-macos-aarch64.yml at the start of the Electron build.
    // The rolling tag and asset upload dates are not build provenance.
    const prefix = `${asset.name} (commit `;
    if (typeof asset.label !== "string" || !asset.label.startsWith(prefix)) return null;
    const match = asset.label.slice(prefix.length).match(/^([a-f0-9]{40}); build started (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\)$/);
    if (!match) return null;
    const startedAt = new Date(match[2]);
    if (!Number.isFinite(startedAt.getTime()) || startedAt.toISOString() !== match[2].replace("Z", ".000Z")) return null;
    return { commit: match[1], startedAt: match[2] };
  };
  const getAlphaBuildMetadata = (build) => {
    const dmg = getAlphaMetadata(build.dmg);
    const zip = getAlphaMetadata(build.zip);
    // An interrupted re-run can leave a pair from different build attempts.
    if (!dmg || !zip || dmg.commit !== zip.commit || dmg.startedAt !== zip.startedAt) return null;
    if (build.dmg.name.replace(/\.dmg$/, "") !== build.zip.name.replace(/\.zip$/, "")) return null;
    return dmg;
  };
  const githubError = (response, channel) => {
    const rateLimitMessage = response.status === 403
      ? " The unauthenticated GitHub API rate limit is 60 requests per hour per IP."
      : "";
    return `Could not load ${channel}: GitHub returned HTTP ${response.status}.${rateLimitMessage}`;
  };
  const getStableGroups = (release) => {
    const version = release.tag_name.slice(1);
    const findAsset = (name) => release.assets.find((asset) => asset.name === name);
    return [
      {
        label: "macOS",
        downloads: [
          { label: "Mac (Apple Silicon)", asset: findAsset(`openwork-mac-arm64-${version}.dmg`) },
          { label: "Mac (Intel)", asset: findAsset(`openwork-mac-x64-${version}.dmg`) },
        ].filter((download) => download.asset),
      },
      {
        label: "Windows",
        downloads: [
          { label: "Windows (x64)", asset: findAsset(`openwork-win-x64-${version}.exe`) },
          { label: "Windows (ARM64)", asset: findAsset(`openwork-win-arm64-${version}.exe`) },
        ].filter((download) => download.asset),
      },
      {
        label: "Linux",
        downloads: [
          { label: "AppImage (x64)", asset: findAsset(`openwork-linux-x86_64-${version}.AppImage`) },
          { label: "AppImage (ARM64)", asset: findAsset(`openwork-linux-arm64-${version}.AppImage`) },
          { label: "tar.gz (x64)", asset: findAsset(`openwork-linux-x64-${version}.tar.gz`) },
          { label: "tar.gz (ARM64)", asset: findAsset(`openwork-linux-arm64-${version}.tar.gz`) },
        ].filter((download) => download.asset),
      },
    ];
  };
  const detectPlatform = () => {
    if (typeof navigator === "undefined") {
      return { label: "macOS", assetName: (version) => `openwork-mac-arm64-${version}.dmg` };
    }
    const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase();
    if (platform.includes("mac")) {
      return { label: "macOS", assetName: (version) => `openwork-mac-arm64-${version}.dmg` };
    }
    if (platform.includes("win")) {
      return { label: "Windows", assetName: (version) => `openwork-win-x64-${version}.exe` };
    }
    if (platform.includes("linux")) {
      return { label: "Linux", assetName: (version) => `openwork-linux-x86_64-${version}.AppImage` };
    }
    return { label: "macOS", assetName: (version) => `openwork-mac-arm64-${version}.dmg` };
  };

  useEffect(() => {
    let active = true;
    const loadStable = async () => {
      try {
        const response = await fetch(STABLE_RELEASES_URL, { headers: GITHUB_HEADERS });
        if (!response.ok) throw new Error(githubError(response, "stable releases"));
        const releases = await response.json();
        if (active) {
          setStableReleases(releases.filter((release) => !release.draft && !release.prerelease && release.tag_name.startsWith("v")));
        }
      } catch (error) {
        if (active) setStableError(error instanceof Error ? error.message : "Could not load stable releases.");
      } finally {
        if (active) setStableLoading(false);
      }
    };
    void loadStable();
    return () => {
      active = false;
    };
  }, []);

  const loadAlpha = async () => {
    if (alphaRequested) return;
    setAlphaRequested(true);
    setAlphaLoading(true);
    setAlphaError("");
    try {
      const response = await fetch(ALPHA_RELEASE_URL, { headers: GITHUB_HEADERS });
      if (!response.ok) throw new Error(githubError(response, "alpha builds"));
      const release = await response.json();
      const buildsByRun = {};
      release.assets.forEach((asset) => {
        if (!asset.name.startsWith("openwork-mac-arm64-") || (!asset.name.endsWith(".dmg") && !asset.name.endsWith(".zip"))) return;
        const runMatch = asset.name.match(/-alpha\.(\d+)(?=[^0-9]|$)/);
        if (!runMatch) return;
        const run = runMatch[1];
        if (!buildsByRun[run]) buildsByRun[run] = { run: Number(run), dmg: null, zip: null };
        if (asset.name.endsWith(".dmg")) buildsByRun[run].dmg = asset;
        if (asset.name.endsWith(".zip")) buildsByRun[run].zip = asset;
      });
      setAlphaBuilds(
        Object.values(buildsByRun)
          .filter((build) => build.dmg && build.zip)
          .map((build) => ({
            ...build,
            version: build.dmg.name.replace("openwork-mac-arm64-", "").replace(/\.dmg$/, ""),
            metadata: getAlphaBuildMetadata(build),
          }))
          .sort((first, second) => second.run - first.run),
      );
    } catch (error) {
      setAlphaError(error instanceof Error ? error.message : "Could not load alpha builds.");
    } finally {
      setAlphaLoading(false);
    }
  };

  const latestStable = stableReleases[0];
  const detectedPlatform = detectPlatform();
  const latestVersion = latestStable ? latestStable.tag_name.slice(1) : "";
  const detectedAsset = latestStable
    ? latestStable.assets.find((asset) => asset.name === detectedPlatform.assetName(latestVersion))
    : null;

  return (
    <div id="openwork-downloads" className="not-prose my-8">
      {latestStable ? (
        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          {detectedAsset ? (
            <a download href={detectedAsset.browser_download_url} className="w-fit rounded-full bg-[#011627] px-5 py-3 text-sm font-medium text-white transition-colors hover:bg-gray-800">
              Download for {detectedPlatform.label} <span aria-hidden="true">⤓</span>
            </a>
          ) : null}
          <span className="text-sm text-gray-500 dark:text-gray-400">
            Version {latestVersion} · {formatDate(latestStable.published_at)}
          </span>
        </div>
      ) : null}

      <div className="mb-5 overflow-x-auto border-b border-gray-200 dark:border-white/10" role="tablist" aria-label="OpenWork download channels">
        <div className="flex min-w-max gap-1">
          <button
            id="downloads-channel-stable"
            type="button"
            role="tab"
            aria-selected={activeChannel === "stable"}
            aria-controls="downloads-stable-list"
            tabIndex={activeChannel === "stable" ? 0 : -1}
            onClick={() => setActiveChannel("stable")}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium ${activeChannel === "stable" ? "border-gray-950 text-gray-950 dark:border-white dark:text-white" : "border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"}`}
          >
            Stable
          </button>
          <button
            id="downloads-channel-alpha"
            type="button"
            role="tab"
            aria-selected={activeChannel === "alpha"}
            aria-controls="downloads-alpha-list"
            tabIndex={activeChannel === "alpha" ? 0 : -1}
            onClick={() => {
              setActiveChannel("alpha");
              void loadAlpha();
            }}
            className={`border-b-2 px-4 py-2.5 text-sm font-medium ${activeChannel === "alpha" ? "border-gray-950 text-gray-950 dark:border-white dark:text-white" : "border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-white"}`}
          >
            Alpha
          </button>
        </div>
      </div>

      <div id="downloads-stable-list" role="tabpanel" aria-labelledby="downloads-channel-stable" hidden={activeChannel !== "stable"}>
        {stableLoading ? <p className="m-0 text-sm text-gray-500 dark:text-gray-400">Loading stable releases…</p> : null}
        {stableError ? <p className="m-0 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{stableError}</p> : null}
        {!stableLoading && !stableError ? (
          <div className="space-y-4">
            {stableReleases.slice(0, stableVisibleCount).map((release, index) => {
              const version = release.tag_name.slice(1);
              const groups = getStableGroups(release);
              return (
                <div key={release.id} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-white/10 dark:bg-gray-950">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex items-center gap-2">
                      <h2 className="m-0 font-mono text-lg font-semibold text-gray-950 dark:text-white">{version}</h2>
                      {index === 0 ? <span className="rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300">Latest</span> : null}
                    </div>
                    <span className="text-sm text-gray-500 dark:text-gray-400">{formatDate(release.published_at)}</span>
                  </div>

                  <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
                    {groups.map((group) => (
                      <div key={group.label}>
                        <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">{group.label}</div>
                        <div className="space-y-2">
                          {group.downloads.map((download) => (
                            <a key={download.asset.name} download href={download.asset.browser_download_url} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-900 transition-colors hover:border-gray-400 dark:border-white/10 dark:text-white dark:hover:border-white/30">
                              <span>{download.label}</span>
                              <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                                {formatSize(download.asset.size)} <span aria-hidden="true">⤓</span>
                              </span>
                            </a>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div className="mt-5 border-t border-gray-100 pt-4 dark:border-white/10">
                    <a href={`https://github.com/different-ai/openwork/releases/tag/${release.tag_name}`} className="text-sm font-medium text-gray-600 hover:text-gray-950 dark:text-gray-400 dark:hover:text-white">Release notes →</a>
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}
        {stableVisibleCount < stableReleases.length ? (
          <div className="mt-6 text-center">
            <button type="button" onClick={() => setStableVisibleCount((count) => count + 8)} className="rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:border-gray-500 dark:border-white/20 dark:bg-gray-950 dark:text-white dark:hover:border-white/40">
              Show more versions
            </button>
          </div>
        ) : null}
      </div>

      <div id="downloads-alpha-list" role="tabpanel" aria-labelledby="downloads-channel-alpha" hidden={activeChannel !== "alpha"}>
        <p className="mb-4 mt-0 text-sm text-gray-500 dark:text-gray-400">Pre-release builds from every merge to dev. macOS Apple Silicon only, signed and notarized. Newest 100 builds are kept.</p>
        {alphaLoading ? <p className="m-0 text-sm text-gray-500 dark:text-gray-400">Loading alpha builds…</p> : null}
        {alphaError ? <p className="m-0 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{alphaError}</p> : null}
        {!alphaLoading && !alphaError ? (
          <div className="space-y-4">
            {alphaBuilds.slice(0, alphaVisibleCount).map((build, index) => (
              <div key={build.run} className="rounded-2xl border border-gray-200 bg-white p-5 dark:border-white/10 dark:bg-gray-950">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-center gap-2">
                    <h2 className="m-0 font-mono text-lg font-semibold text-gray-950 dark:text-white">{build.version}</h2>
                    {index === 0 ? <span className="rounded-full border border-green-200 bg-green-50 px-2.5 py-1 text-xs font-semibold text-green-700 dark:border-green-800 dark:bg-green-950 dark:text-green-300">Latest</span> : null}
                  </div>
                </div>

                {build.metadata ? (
                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-500 dark:text-gray-400">
                    <time dateTime={build.metadata.startedAt}>{buildTimeFormatter.format(new Date(build.metadata.startedAt))}</time>
                    <a href={`https://github.com/different-ai/openwork/commit/${build.metadata.commit}`} title={build.metadata.commit} className="font-mono underline underline-offset-2 hover:text-gray-950 dark:hover:text-white">{build.metadata.commit.slice(0, 7)}</a>
                  </div>
                ) : null}

                <div className="mt-5 grid grid-cols-2 gap-3">
                  {[
                    { label: "DMG", asset: build.dmg },
                    { label: "ZIP", asset: build.zip },
                  ].map((download) => (
                    <a key={download.label} download href={download.asset.browser_download_url} className="flex items-center justify-between gap-3 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-900 transition-colors hover:border-gray-400 dark:border-white/10 dark:text-white dark:hover:border-white/30">
                      <span>{download.label}</span>
                      <span className="flex shrink-0 items-center gap-2 text-xs font-normal text-gray-500 dark:text-gray-400">
                        {formatSize(download.asset.size)} <span aria-hidden="true">⤓</span>
                      </span>
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
        {alphaVisibleCount < alphaBuilds.length ? (
          <div className="mt-6 text-center">
            <button type="button" onClick={() => setAlphaVisibleCount((count) => count + 20)} className="rounded-full border border-gray-300 bg-white px-5 py-2.5 text-sm font-medium text-gray-900 transition-colors hover:border-gray-500 dark:border-white/20 dark:bg-gray-950 dark:text-white dark:hover:border-white/40">
              Show more versions
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
};
