// Version comparator + update gating helpers.
//
// Ported from dev's Solid system-state.ts (#1476 + #1512). Pure functions
// so they're reusable from any React feature site once the updater flow
// gets wired.

import { createDenClient, readDenSettings, type DenDesktopConfig } from "./den";

type ParsedVersion = {
  release: number[];
  prerelease: string[];
};

function parseComparableVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, "");
  if (!normalized) return null;

  const [versionCore] = normalized.split("+", 1);
  if (!versionCore) return null;

  const [releasePart, prereleasePart = ""] = versionCore.split("-", 2);
  const release = releasePart.split(".").map((segment) => Number(segment));
  if (!release.length || release.some((segment) => !Number.isInteger(segment) || segment < 0)) {
    return null;
  }

  const prerelease = prereleasePart
    .split(".")
    .flatMap((segment) => {
      const trimmed = segment.trim();
      return trimmed ? [trimmed] : [];
    });

  return { release, prerelease };
}

function comparePrereleaseIdentifiers(left: string[], right: string[]): number {
  // semver-ish: absence of prerelease ranks higher than presence.
  if (!left.length && !right.length) return 0;
  if (!left.length) return 1;
  if (!right.length) return -1;

  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;

    const leftNumeric = /^\d+$/.test(leftPart) ? Number(leftPart) : null;
    const rightNumeric = /^\d+$/.test(rightPart) ? Number(rightPart) : null;

    if (leftNumeric !== null && rightNumeric !== null) {
      if (leftNumeric !== rightNumeric) return leftNumeric < rightNumeric ? -1 : 1;
      continue;
    }

    if (leftNumeric !== null) return -1;
    if (rightNumeric !== null) return 1;

    const comparison = leftPart.localeCompare(rightPart);
    if (comparison !== 0) return comparison < 0 ? -1 : 1;
  }

  return 0;
}

function releasePart(value: string): number[] | null {
  return parseComparableVersion(value)?.release ?? null;
}

/**
 * Compare two version strings. Returns -1 / 0 / 1 as usual, or null if
 * either side fails to parse. Accepts an optional leading `v` and handles
 * prerelease tags (e.g. `0.11.212-alpha.3`).
 */
export function compareVersions(left: string, right: string): number | null {
  const parsedLeft = parseComparableVersion(left);
  const parsedRight = parseComparableVersion(right);
  if (!parsedLeft || !parsedRight) return null;

  const count = Math.max(parsedLeft.release.length, parsedRight.release.length);
  for (let index = 0; index < count; index += 1) {
    const leftPart = parsedLeft.release[index] ?? 0;
    const rightPart = parsedRight.release[index] ?? 0;
    if (leftPart !== rightPart) return leftPart < rightPart ? -1 : 1;
  }

  return comparePrereleaseIdentifiers(parsedLeft.prerelease, parsedRight.prerelease);
}

/**
 * Apply the org-level `allowedDesktopVersions` filter (dev #1512). When
 * the array is unset, everything is allowed; when it's set, the candidate
 * update version must match one of the allowed versions exactly (by
 * semver comparison, so leading `v` prefixes and trailing build metadata
 * are treated equivalently).
 */
export function isUpdateAllowedByDesktopConfig(
  updateVersion: string,
  desktopConfig: DenDesktopConfig | null | undefined,
): boolean {
  if (!Array.isArray(desktopConfig?.allowedDesktopVersions)) {
    return true;
  }

  return desktopConfig.allowedDesktopVersions.some(
    (allowedVersion) => compareVersions(updateVersion, allowedVersion) === 0,
  );
}

function maxAllowedDesktopVersion(desktopConfig: DenDesktopConfig | null | undefined): string | null {
  if (!Array.isArray(desktopConfig?.allowedDesktopVersions)) {
    return null;
  }

  let maxVersion: string | null = null;
  for (const version of desktopConfig.allowedDesktopVersions) {
    if (parseComparableVersion(version) === null) continue;
    if (maxVersion === null) {
      maxVersion = version;
      continue;
    }
    const comparison = compareVersions(version, maxVersion);
    if (comparison !== null && comparison > 0) {
      maxVersion = version;
    }
  }
  return maxVersion;
}

function effectiveMaxDesktopVersion(
  denLatestAppVersion: string,
  desktopConfig: DenDesktopConfig | null | undefined,
): string {
  const orgMaxVersion = maxAllowedDesktopVersion(desktopConfig);
  if (!orgMaxVersion) return denLatestAppVersion;
  const comparison = compareVersions(orgMaxVersion, denLatestAppVersion);
  return comparison !== null && comparison < 0 ? orgMaxVersion : denLatestAppVersion;
}

function isWithinOnePatchAhead(updateVersion: string, maxVersion: string): boolean {
  const directComparison = compareVersions(updateVersion, maxVersion);
  if (directComparison !== null && directComparison <= 0) {
    return true;
  }

  const updateRelease = releasePart(updateVersion);
  const maxRelease = releasePart(maxVersion);
  if (!updateRelease || !maxRelease) return false;

  const updateMajor = updateRelease[0] ?? 0;
  const updateMinor = updateRelease[1] ?? 0;
  const updatePatch = updateRelease[2] ?? 0;
  const maxMajor = maxRelease[0] ?? 0;
  const maxMinor = maxRelease[1] ?? 0;
  const maxPatch = maxRelease[2] ?? 0;

  return updateMajor === maxMajor && updateMinor === maxMinor && updatePatch <= maxPatch + 1;
}

async function readDenLatestAppVersion(): Promise<string | null> {
  try {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      ...(token ? { token } : {}),
    });
    const metadata = await client.getAppVersionMetadata();
    return metadata.latestAppVersion;
  } catch {
    return null;
  }
}

/**
 * Ask Den for the currently-supported latest app version (dev #1476) and
 * return true only when the candidate update version is the latest
 * version or older. If Den is unreachable or returns an invalid payload,
 * this returns `false` — the caller must treat that as "do not surface
 * the update".
 *
 * No-op safe: callers can invoke this without any Den auth; the client
 * will omit the token when none is persisted.
 */
export async function isUpdateSupportedByDen(updateVersion: string): Promise<boolean> {
  const latestAppVersion = await readDenLatestAppVersion();
  if (!latestAppVersion) return false;
  const comparison = compareVersions(updateVersion, latestAppVersion);
  return comparison !== null && comparison <= 0;
}

/**
 * Alpha channel builds may run one patch ahead of the current Den/org maximum
 * (e.g. Den allows 0.13.3, alpha 0.13.4-alpha.N is allowed). Larger jumps are
 * still blocked so alpha cannot bypass staged rollout ceilings entirely.
 */
export async function isAlphaUpdateAllowed(
  updateVersion: string,
  desktopConfig: DenDesktopConfig | null | undefined,
): Promise<boolean> {
  const latestAppVersion = await readDenLatestAppVersion();
  if (!latestAppVersion) return false;
  const effectiveMaxVersion = effectiveMaxDesktopVersion(latestAppVersion, desktopConfig);
  return isWithinOnePatchAhead(updateVersion, effectiveMaxVersion);
}

/**
 * Combined gate: the update must be supported by Den (version metadata
 * endpoint) AND allowed by the active org's `allowedDesktopVersions` if
 * one is configured. Intended to be the single call site the React
 * updater flow makes before surfacing an update as installable.
 */
export async function isUpdateAllowed(
  updateVersion: string,
  desktopConfig: DenDesktopConfig | null | undefined,
): Promise<boolean> {
  if (!isUpdateAllowedByDesktopConfig(updateVersion, desktopConfig)) {
    return false;
  }
  return isUpdateSupportedByDen(updateVersion);
}
