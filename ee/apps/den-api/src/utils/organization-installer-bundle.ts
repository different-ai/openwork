import { INSTALL_SIDECAR_FILENAME, type InstallConfig } from "@openwork/install-config"
import { createStoredZipStream, appendStoredEntriesToZipStream } from "./zip-append.js"
import {
  desktopReleaseAssetName,
  genericInstallerAssetName,
  type OrganizationInstallerPlatform,
} from "./installer-release.js"

export function safeOrganizationInstallerSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "organization"
}

export function organizationInstallerArtifactNames(platform: OrganizationInstallerPlatform, releaseTag: string) {
  const desktopFileName = desktopReleaseAssetName(platform, releaseTag)
  const genericFileName = genericInstallerAssetName(platform)
  if (!desktopFileName || !genericFileName) {
    throw new Error(`Unsupported organization installer platform: ${platform}`)
  }
  return { desktopFileName, genericFileName }
}

export function organizationInstallerBundleFileName(clientName: string, platform: OrganizationInstallerPlatform) {
  return `OpenWork-Installer-${safeOrganizationInstallerSlug(clientName)}-${platform}.zip`
}

export function buildOrganizationInstallerBundle(input: {
  platform: OrganizationInstallerPlatform
  config: InstallConfig
  desktopFileName: string
  desktopArtifact: Buffer
  genericInstallerArtifact: Buffer
}) {
  const sidecar = Buffer.from(`${JSON.stringify(input.config, null, 2)}\n`, "utf8")
  if (input.platform.startsWith("mac-")) {
    return appendStoredEntriesToZipStream(input.genericInstallerArtifact, [
      { name: INSTALL_SIDECAR_FILENAME, content: sidecar },
      { name: input.desktopFileName, content: input.desktopArtifact },
    ])
  }
  return createStoredZipStream([
    { name: "OpenWork Installer.exe", content: input.genericInstallerArtifact },
    { name: INSTALL_SIDECAR_FILENAME, content: sidecar },
    { name: input.desktopFileName, content: input.desktopArtifact },
  ])
}
