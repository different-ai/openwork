// Minimal strict SemVer 2.0.0 support.
//
// The contract deliberately avoids npm-style range grammar. A mis-parsed range
// means installing an app the host cannot actually run, so compatibility is
// expressed as an explicit `{ min, max_exclusive? }` window and checked with
// plain comparisons. Everything here is total: no throw, no partial parse.

const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

export type SemVer = {
  major: number
  minor: number
  patch: number
  prerelease: readonly string[]
  build: string | null
  raw: string
}

export function parseSemVer(value: string): SemVer | null {
  const match = SEMVER_PATTERN.exec(value)
  if (!match) return null
  const [, major, minor, patch, prerelease, build] = match
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split(".") : [],
    build: build ?? null,
    raw: value,
  }
}

export function isSemVer(value: string): boolean {
  return SEMVER_PATTERN.test(value)
}

function comparePrereleaseIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  // SemVer 2.0.0 §11: numeric identifiers always sort below alphanumeric ones.
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Returns <0, 0, or >0. Build metadata is ignored, per SemVer §10. */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  if (a.patch !== b.patch) return a.patch - b.patch
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const left = a.prerelease[index]
    const right = b.prerelease[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    const result = comparePrereleaseIdentifier(left, right)
    if (result !== 0) return result
  }
  return 0
}

export function compareVersionStrings(a: string, b: string): number | null {
  const left = parseSemVer(a)
  const right = parseSemVer(b)
  if (!left || !right) return null
  return compareSemVer(left, right)
}

export type VersionWindow = {
  /** Inclusive lower bound. */
  min: string
  /** Exclusive upper bound. Omitted means open-ended. */
  max_exclusive?: string
}

export type VersionWindowCheck =
  | { satisfied: true }
  | { satisfied: false; reason: "invalid_version" | "below_min" | "at_or_above_max" }

/** Checks `min <= version < max_exclusive`. Prerelease ordering follows SemVer. */
export function satisfiesWindow(version: string, window: VersionWindow): VersionWindowCheck {
  const current = parseSemVer(version)
  const min = parseSemVer(window.min)
  if (!current || !min) return { satisfied: false, reason: "invalid_version" }
  if (compareSemVer(current, min) < 0) return { satisfied: false, reason: "below_min" }
  if (window.max_exclusive !== undefined) {
    const max = parseSemVer(window.max_exclusive)
    if (!max) return { satisfied: false, reason: "invalid_version" }
    if (compareSemVer(current, max) >= 0) return { satisfied: false, reason: "at_or_above_max" }
  }
  return { satisfied: true }
}

export function formatWindow(window: VersionWindow): string {
  return window.max_exclusive === undefined
    ? `>= ${window.min}`
    : `>= ${window.min} and < ${window.max_exclusive}`
}
