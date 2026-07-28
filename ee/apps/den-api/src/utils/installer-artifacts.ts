import { stat } from "node:fs/promises"
import path from "node:path"
import { env } from "../env.js"

export type ConfiguredInstallerArtifact = {
  filePath: string
  fileName?: string
  size: number
}

export const DEFAULT_INSTALLER_RELEASE_REPO = "different-ai/openwork"

export function installerReleaseAssetUrl(
  fileName: string,
  options: { releaseRepo?: string; releaseTag?: string } = {},
) {
  const releaseRepo = options.releaseRepo ?? env.installerReleaseRepo
  const releaseTag = options.releaseTag ?? env.installerReleaseTag
  return `https://github.com/${releaseRepo}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(fileName)}`
}

export function installerLatestReleaseAssetUrl(
  fileName: string,
  options: { releaseRepo?: string } = {},
) {
  const releaseRepo = options.releaseRepo ?? env.installerReleaseRepo
  // GitHub latest only flips when publish-release un-drafts after release assets are ready,
  // so this URL cannot 404 during a release window.
  return `https://github.com/${releaseRepo}/releases/latest/download/${encodeURIComponent(fileName)}`
}

export function desktopReleaseAssetName(platform: string, releaseTag: string) {
  const version = releaseTag.startsWith("v") ? releaseTag.slice(1) : releaseTag
  if (platform === "mac-arm64" || platform === "mac-x64") {
    return `openwork-${platform}-${version}.dmg`
  }
  if (platform === "win-x64") {
    return `openwork-${platform}-${version}.exe`
  }
  if (platform === "linux-x64") {
    return `openwork-linux-x86_64-${version}.AppImage`
  }
  if (platform === "linux-arm64") {
    return `openwork-linux-arm64-${version}.AppImage`
  }
  return null
}

export function enterpriseDesktopReleaseAssetName(platform: string, releaseTag: string) {
  const publicName = desktopReleaseAssetName(platform, releaseTag)
  return publicName?.replace(/^openwork-/, "openwork-enterprise-") ?? null
}

export function cloudDesktopReleaseAssetName(platform: string, releaseTag: string) {
  const publicName = desktopReleaseAssetName(platform, releaseTag)
  return publicName?.replace(/^openwork-/, "openwork-cloud-") ?? null
}

/**
 * Resolves only an explicitly provisioned desktop artifact. The normal
 * internet-connected path redirects the browser to GitHub instead, so Den
 * never downloads or caches a release artifact on demand.
 */
export async function resolveConfiguredInstallerArtifact(
  fileName: string,
): Promise<ConfiguredInstallerArtifact | null> {
  if (!env.installerArtifactsDir) {
    return null
  }
  const filePath = path.join(env.installerArtifactsDir, fileName)
  try {
    const artifact = await stat(filePath)
    if (artifact.isFile()) {
      return { filePath, fileName, size: artifact.size }
    }
  } catch {
    // Missing or inaccessible artifacts are treated as unmounted.
  }
  return null
}
