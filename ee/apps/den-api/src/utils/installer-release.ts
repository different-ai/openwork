export type OrganizationInstallerPlatform = "mac-arm64" | "mac-x64" | "win-x64"

export const organizationInstallerPlatforms: readonly OrganizationInstallerPlatform[] = ["mac-arm64", "mac-x64", "win-x64"]

export function isOrganizationInstallerPlatform(value: string): value is OrganizationInstallerPlatform {
  return organizationInstallerPlatforms.some((platform) => platform === value)
}

export function installerReleaseArtifactUrl(fileName: string, releaseRepo: string, releaseTag: string) {
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
  return null
}

export function genericInstallerAssetName(platform: string) {
  if (platform === "mac-arm64" || platform === "mac-x64") {
    return `openwork-installer-${platform}.zip`
  }
  if (platform === "win-x64") {
    return "openwork-installer-win-x64.exe"
  }
  return null
}
