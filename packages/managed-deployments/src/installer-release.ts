/**
 * An installer release is one app version plus the installer's own revision
 * for that version. A release without a revision is revision 1, so every
 * release published before revisions existed keeps its identity.
 *
 * This file imports nothing: the release workflow loads it directly in Node.
 */
export const MAX_INSTALLER_REVISION = 9999

export type InstallerReleaseIdentity = { version: string; installerRevision?: number | null }

export function isInstallerRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_INSTALLER_REVISION
}

/** The revision a stored or published value stands for: absent means 1. */
export function installerRevisionOf(value: number | null | undefined): number {
  return value ?? 1
}

/** Coordinates carry a revision only above 1, so revision 1 serializes as it always has. */
export function installerRevisionField(value: number | null | undefined): { installerRevision?: number } {
  const revision = installerRevisionOf(value)
  return revision > 1 ? { installerRevision: revision } : {}
}

/** The folder a release is published in, next to its version's revision 1: `0.19.3`, `0.19.3_r2`. */
export function installerReleaseFolder(version: string, installerRevision?: number | null): string {
  const revision = installerRevisionOf(installerRevision)
  return revision > 1 ? `${version}_r${revision}` : version
}

/** How a release is named to a person: `0.19.3`, `0.19.3 (revision 2)`. */
export function installerReleaseLabel(version: string, installerRevision?: number | null): string {
  const revision = installerRevisionOf(installerRevision)
  return revision > 1 ? `${version} (revision ${revision})` : version
}

type ParsedVersion = { release: bigint[]; prerelease: string[] }
function parseVersion(value: string): ParsedVersion | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(value)
  if (!match) return null
  return { release: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease: match[4]?.split(".") ?? [] }
}

/** Semantic version comparison, exact for numbers of any size; returns null when either value is not a version. */
export function compareVersions(left: string, right: string): number | null {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return null
  for (let index = 0; index < 3; index += 1) {
    if (a.release[index] !== b.release[index]) return a.release[index] < b.release[index] ? -1 : 1
  }
  if (!a.prerelease.length || !b.prerelease.length) return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length ? -1 : 1
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const x = a.prerelease[index]
    const y = b.prerelease[index]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x) ? BigInt(x) : null
    const yn = /^\d+$/.test(y) ? BigInt(y) : null
    if (xn !== null && yn !== null) {
      if (xn === yn) continue
      return xn < yn ? -1 : 1
    }
    if (xn !== null) return -1
    if (yn !== null) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * Orders two installer releases: app version first, then installer revision.
 * Returns null when a version is not a version or a revision is not a revision.
 */
export function compareInstallerRelease(left: InstallerReleaseIdentity, right: InstallerReleaseIdentity): number | null {
  const a = installerRevisionOf(left.installerRevision)
  const b = installerRevisionOf(right.installerRevision)
  if (!isInstallerRevision(a) || !isInstallerRevision(b)) return null
  const versions = compareVersions(left.version, right.version)
  if (versions === null || versions !== 0) return versions
  return a === b ? 0 : a < b ? -1 : 1
}
