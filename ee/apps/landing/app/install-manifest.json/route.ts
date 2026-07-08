// GET /install-manifest.json
//
// Resolves the latest OpenWork desktop release on GitHub and returns an install
// manifest in the shape the `openwork-bootstrap install app` command expects:
//
//   { version, artifacts: { <platform>: { <arch>: { type, url, appName } } } }
//
// Platforms/arches are only included when a matching release asset exists, so
// the manifest is always current without manual maintenance.

const GITHUB_REPO = "different-ai/openwork";
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=20`;

type GithubAsset = { name: string; browser_download_url: string };
type GithubRelease = {
  tag_name: string;
  name: string | null;
  prerelease: boolean;
  draft: boolean;
  assets: GithubAsset[];
};

type ManifestArtifact = {
  type: "dmg" | "zip" | "tar.gz" | "appimage" | "exe" | "msi";
  url: string;
  appName?: string;
};

// Only treat OpenWork desktop-app installers as artifacts. The orchestrator
// release ships sidecar/CLI binaries (openwork-server-*.exe,
// openwork-bun-*) that must NOT be treated as the desktop app, so we positively
// require the desktop app's OS-tagged naming (openwork-mac / openwork-linux /
// openwork-win + an installer extension).
const SIDECAR_HINTS = ["orchestrator", "server", "bun-", "sidecar", "opencode"];

function isDesktopAppAsset(name: string): boolean {
  const lower = name.toLowerCase();
  if (!lower.startsWith("openwork")) return false;
  // exclude update metadata / checksums
  if (/\.(blockmap|yml|yaml|json|txt|sig|sha256)$/i.test(lower)) return false;
  // exclude any sidecar/CLI binary that also happens to start with "openwork".
  if (SIDECAR_HINTS.some((hint) => lower.includes(hint))) return false;
  // require a desktop OS tag so we never pick up a stray asset.
  return /(mac|darwin|osx|linux|win)/.test(lower);
}

function artifactTypeFor(name: string): ManifestArtifact["type"] | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".dmg")) return "dmg";
  if (lower.endsWith(".appimage")) return "appimage";
  if (lower.endsWith(".tar.gz") || lower.endsWith(".tgz")) return "tar.gz";
  if (lower.endsWith(".msi")) return "msi";
  if (lower.endsWith(".exe")) return "exe";
  // .zip is only treated as a desktop artifact for non-dmg platforms; on macOS
  // we prefer the .dmg, so skip zip there (handled by ordering below).
  if (lower.endsWith(".zip")) return "zip";
  return null;
}

// Map a release asset to (platform, arch) using the OS/arch hints in its name.
function platformArchFor(name: string): { platform: string; arch: string } | null {
  const lower = name.toLowerCase();
  const arch = lower.includes("arm64") || lower.includes("aarch64")
    ? "arm64"
    : lower.includes("x64") || lower.includes("x86_64") || lower.includes("amd64")
      ? "x64"
      : null;

  if (lower.endsWith(".dmg") || lower.includes("darwin") || lower.includes("mac") || lower.includes("osx")) {
    return { platform: "darwin", arch: arch ?? "arm64" };
  }
  if (lower.endsWith(".appimage") || lower.includes("linux")) {
    return { platform: "linux", arch: arch ?? "x64" };
  }
  if (lower.endsWith(".exe") || lower.endsWith(".msi") || lower.includes("win")) {
    return { platform: "win32", arch: arch ?? "x64" };
  }
  return null;
}

// Prefer real installers per platform: dmg on macOS, AppImage on Linux, exe/msi
// on Windows. Higher number wins when multiple assets map to the same slot.
function preferenceFor(type: ManifestArtifact["type"]): number {
  switch (type) {
    case "dmg":
      return 5;
    case "appimage":
      return 5;
    case "msi":
      return 4;
    case "exe":
      return 3;
    case "tar.gz":
      return 2;
    case "zip":
      return 1;
  }
}

function buildManifest(release: GithubRelease) {
  const artifacts: Record<string, Record<string, ManifestArtifact & { _pref: number }>> = {};

  for (const asset of release.assets) {
    if (!isDesktopAppAsset(asset.name)) continue;
    const type = artifactTypeFor(asset.name);
    const target = platformArchFor(asset.name);
    if (!type || !target) continue;

    artifacts[target.platform] ??= {};
    const existing = artifacts[target.platform][target.arch];
    const pref = preferenceFor(type);
    if (!existing || pref > existing._pref) {
      artifacts[target.platform][target.arch] = {
        _pref: pref,
        type,
        url: asset.browser_download_url,
        ...(type === "dmg" ? { appName: "OpenWork.app" } : {}),
      };
    }
  }

  // Strip the internal preference field from the output.
  const cleaned: Record<string, Record<string, ManifestArtifact>> = {};
  for (const [platform, byArch] of Object.entries(artifacts)) {
    cleaned[platform] = {};
    for (const [arch, artifact] of Object.entries(byArch)) {
      const { _pref, ...rest } = artifact;
      void _pref;
      cleaned[platform][arch] = rest;
    }
  }

  return {
    version: release.tag_name,
    source: `https://github.com/${GITHUB_REPO}/releases/tag/${release.tag_name}`,
    artifacts: cleaned,
  };
}

export async function GET() {
  try {
    const response = await fetch(RELEASES_API, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "openwork-install-manifest",
      },
      next: { revalidate: 300 },
    });
    if (!response.ok) {
      return Response.json(
        { error: "github_releases_unavailable", status: response.status },
        { status: 502 },
      );
    }

    const releases = (await response.json()) as GithubRelease[];
    // Prefer the newest release (incl. prereleases/alpha) that ships an actual
    // OpenWork desktop installer (not the orchestrator sidecar bundle).
    const release = releases
      .filter((r) => !r.draft)
      .find((r) =>
        r.assets.some(
          (a) => isDesktopAppAsset(a.name) && artifactTypeFor(a.name) && platformArchFor(a.name),
        ),
      );

    if (!release) {
      return Response.json({ error: "no_release_with_desktop_assets" }, { status: 404 });
    }

    return Response.json(buildManifest(release), {
      headers: {
        "cache-control": "public, max-age=300, stale-while-revalidate=3600",
      },
    });
  } catch (error) {
    return Response.json(
      { error: "manifest_resolution_failed", message: error instanceof Error ? error.message : String(error) },
      { status: 502 },
    );
  }
}
