type ManagedInstallerProvider = "aws" | "gcp"

export type ManagedInstallerCoordinates = {
  version: string
  templateUrl: string
  bundleUrl: string
  bundleSha256: string
}

export type ManagedInstallerQualification = {
  freshInstallUrl: string
  approvedUpdateUrl: string
}

export type ManagedInstallerValidation = {
  id: string
  provider: ManagedInstallerProvider
  release: ManagedInstallerCoordinates
  manifestSha256: string
  services: string[]
  verifiedAt: string
  expiresAt: string
  verifiedBy: string
  canPin: boolean
}
