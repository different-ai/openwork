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
    .map((segment) => segment.trim())
    .filter(Boolean);

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
  try {
    const settings = readDenSettings();
    const token = settings.authToken?.trim() ?? "";
    const client = createDenClient({
      baseUrl: settings.baseUrl,
      apiBaseUrl: settings.apiBaseUrl,
      ...(token ? { token } : {}),
    });
    const metadata = await client.getAppVersionMetadata();
    const comparison = compareVersions(updateVersion, metadata.latestAppVersion);
    return comparison !== null && comparison <= 0;
  } catch {
    return false;
  }
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
