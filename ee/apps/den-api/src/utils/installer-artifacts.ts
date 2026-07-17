import { stat } from "node:fs/promises"
import path from "node:path"
import { env } from "../env.js"

export type ConfiguredInstallerArtifact = {
  filePath: string
  size: number
}

export function installerReleaseAssetUrl(
  fileName: string,
  options: { releaseRepo?: string; releaseTag?: string } = {},
) {
  const releaseRepo = options.releaseRepo ?? env.installerReleaseRepo
  const releaseTag = options.releaseTag ?? env.installerReleaseTag
  return `https://github.com/${releaseRepo}/releases/download/${encodeURIComponent(releaseTag)}/${encodeURIComponent(fileName)}`
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

/**
 * Resolves only an explicitly provisioned standard installer. The normal
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
    return artifact.isFile() ? { filePath, size: artifact.size } : null
  } catch {
    return null
  }
}
