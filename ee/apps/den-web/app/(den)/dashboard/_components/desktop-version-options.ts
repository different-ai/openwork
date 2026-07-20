type DesktopVersionMetadata = {
  minAppVersion: string
  latestAppVersion: string
  publishedDesktopVersions: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function normalizeDesktopVersionString(value: string): string | null {
  const normalized = value.trim().replace(/^v/i, "")
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null
}

export function compareDesktopVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) return difference
  }
  return 0
}

export function getDesktopVersionMetadata(payload: unknown): DesktopVersionMetadata | null {
  if (!isRecord(payload)) return null

  const minAppVersion = typeof payload.minAppVersion === "string"
    ? normalizeDesktopVersionString(payload.minAppVersion)
    : null
  const latestAppVersion = typeof payload.latestAppVersion === "string"
    ? normalizeDesktopVersionString(payload.latestAppVersion)
    : null
  const publishedDesktopVersions = Array.isArray(payload.publishedDesktopVersions)
    ? payload.publishedDesktopVersions.flatMap((value) => {
        if (typeof value !== "string") return []
        const normalized = normalizeDesktopVersionString(value)
        return normalized ? [normalized] : []
      })
    : []

  if (!minAppVersion || !latestAppVersion) return null

  return {
    minAppVersion,
    latestAppVersion,
    publishedDesktopVersions: [...new Set(
      publishedDesktopVersions.length > 0 ? publishedDesktopVersions : [latestAppVersion],
    )].sort((left, right) => compareDesktopVersions(right, left)),
  }
}

export function initialAllowedDesktopVersions(
  storedVersions: string[] | null,
  publishedVersions: string[],
): string[] {
  return storedVersions === null ? publishedVersions : [...storedVersions]
}

export function allPublishedDesktopVersionsAllowed(input: {
  draftVersions: string[]
  publishedVersions: string[]
}): boolean {
  if (input.publishedVersions.length === 0) return false

  const publishedSet = new Set(input.publishedVersions)
  const draftSet = new Set(input.draftVersions)
  const hasStoredVersionOutsideInventory = input.draftVersions.some((version) => !publishedSet.has(version))
  return !hasStoredVersionOutsideInventory && input.publishedVersions.every((version) => draftSet.has(version))
}
