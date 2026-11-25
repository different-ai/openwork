import { isDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"

export class GithubInstallationApprovalError extends Error {
  constructor() {
    super("This GitHub App installation is not approved for this organization. Contact your deployment operator.")
    this.name = "GithubInstallationApprovalError"
  }
}

function isInstallationId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function githubAccountInstallationId(remoteId: string, legacyInstallationId?: unknown): number {
  const installationId = Number(remoteId)
  if (!isInstallationId(installationId) || String(installationId) !== remoteId
    || (legacyInstallationId !== undefined && legacyInstallationId !== installationId)) {
    throw new GithubInstallationApprovalError()
  }
  return installationId
}

export function parseGithubInstallationBindings(raw: string | undefined): ReadonlyMap<number, DenTypeId<"organization">> | null {
  if (!raw?.trim()) return new Map()
  try {
    const entries: unknown = JSON.parse(raw)
    if (!Array.isArray(entries)) return null
    const bindings = new Map<number, DenTypeId<"organization">>()
    for (const entry of entries) {
      if (!entry || typeof entry !== "object" || Object.keys(entry).length !== 2
        || !("installationId" in entry) || !("organizationId" in entry)) return null
      const { installationId, organizationId } = entry
      if (!isInstallationId(installationId) || !isDenTypeId("organization", organizationId) || bindings.has(installationId)) return null
      bindings.set(installationId, organizationId)
    }
    return bindings
  } catch {
    return null
  }
}

export function githubInstallationOwner(bindings: ReadonlyMap<number, DenTypeId<"organization">> | null, installationId: number) {
  return isInstallationId(installationId) ? bindings?.get(installationId) : undefined
}

const approvedBindings = parseGithubInstallationBindings(process.env.GITHUB_CONNECTOR_INSTALLATION_BINDINGS)
if (!approvedBindings) {
  console.error("Invalid GITHUB_CONNECTOR_INSTALLATION_BINDINGS; GitHub App connector access is denied.")
}

export function approvedGithubInstallationOwner(installationId: number) {
  return githubInstallationOwner(approvedBindings, installationId)
}

export function requireApprovedGithubInstallation(organizationId: string, installationId: number) {
  if (!organizationId || approvedGithubInstallationOwner(installationId) !== organizationId) {
    throw new GithubInstallationApprovalError()
  }
}
