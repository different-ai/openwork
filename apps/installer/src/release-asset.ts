const GITHUB_REPO = "different-ai/openwork"

export type ReleaseAsset = {
  version: string
  fileName: string
  url: string
  type: "dmg" | "exe" | "appimage"
}

/**
 * Release assets follow a fixed naming scheme (see the stable release
 * workflow): openwork-mac-<arch>-<v>.dmg, openwork-win-x64-<v>.exe,
 * openwork-linux-x86_64|arm64-<v>.AppImage — so the download URL is
 * deterministic from (version, platform, arch); no releases-API listing needed.
 */
export function releaseAssetFor(
  version: string,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ReleaseAsset {
  const normalized = version.trim().replace(/^v/i, "")
  if (!normalized) throw new Error("version is required")
  if (arch !== "arm64" && arch !== "x64") {
    throw new Error(`unsupported architecture: ${arch}`)
  }

  const build = (fileName: string, type: ReleaseAsset["type"]): ReleaseAsset => ({
    version: normalized,
    fileName,
    type,
    url: `https://github.com/${GITHUB_REPO}/releases/download/v${normalized}/${encodeURIComponent(fileName)}`,
  })

  if (platform === "darwin") {
    return build(`openwork-mac-${arch}-${normalized}.dmg`, "dmg")
  }
  if (platform === "win32") {
    if (arch !== "x64") throw new Error(`unsupported Windows architecture: ${arch}`)
    return build(`openwork-win-x64-${normalized}.exe`, "exe")
  }
  if (platform === "linux") {
    // The AppImage uses x86_64 in its name while the tarball uses x64.
    const appImageArch = arch === "x64" ? "x86_64" : "arm64"
    return build(`openwork-linux-${appImageArch}-${normalized}.AppImage`, "appimage")
  }
  throw new Error(`unsupported platform: ${platform}`)
}
