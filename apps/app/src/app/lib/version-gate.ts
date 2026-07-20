// Version comparator + update gating helpers.
//
// Ported from dev's Solid system-state.ts (#1476 + #1512). Pure functions
// so they're reusable from any React feature site once the updater flow
// gets wired.

import {
  createDenClient,
  readDenSettings,
  type DenAppVersionMetadata,
  type DenDesktopConfig,
} from "./den";
import type { ReleaseChannel } from "../types";

declare global {
  interface Window {
    __openworkReadDesktopVersionMetadataEval?: () => DenAppVersionMetadata | Promise<DenAppVersionMetadata>;
  }
}

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

function normalizeStableDesktopVersion(value: string): string | null {
  const normalized = value.trim().replace(/^v/i, "");
  return /^\d+\.\d+\.\d+$/.test(normalized) ? normalized : null;
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

export function isAlphaChannelAllowedByDesktopConfig(
  desktopConfig: DenDesktopConfig | null | undefined,
): boolean {
  return desktopConfig?.allowAlphaUpdates !== false;
}

export function resolveDesktopUpdateChannel(
  channel: ReleaseChannel,
  desktopConfig: DenDesktopConfig | null | undefined,
): ReleaseChannel {
  return channel === "alpha" && !isAlphaChannelAllowedByDesktopConfig(desktopConfig)
    ? "stable"
    : channel;
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
    const metadata = await readFreshDenAppVersionMetadata();
    return metadata.latestAppVersion;
  } catch {
    return null;
  }
}

export async function readFreshDenAppVersionMetadata(): Promise<DenAppVersionMetadata> {
  if (import.meta.env.DEV && typeof window !== "undefined" && window.__openworkReadDesktopVersionMetadataEval) {
    return window.__openworkReadDesktopVersionMetadataEval();
  }
  const settings = readDenSettings();
  const token = settings.authToken?.trim() ?? "";
  return createDenClient({
    baseUrl: settings.baseUrl,
    ...(token ? { token } : {}),
  }).getAppVersionMetadata();
}

export type StableDesktopUpdateSelection =
  | { kind: "update"; targetVersion: string; latestPublishedVersion: string }
  | { kind: "blocked"; latestPublishedVersion: string }
  | { kind: "current"; latestPublishedVersion: string };

/**
 * Select the highest stable release that is both published and approved.
 * The explicit Den inventory is the trust boundary: stored policy entries
 * that do not correspond to a published updater manifest are never targeted.
 */
export function selectStableDesktopUpdate(input: {
  currentVersion: string;
  metadata: DenAppVersionMetadata;
  desktopConfig: DenDesktopConfig | null | undefined;
}): StableDesktopUpdateSelection | null {
  const currentVersion = normalizeStableDesktopVersion(input.currentVersion);
  if (!currentVersion) return null;

  const publishedVersions = [...new Set(input.metadata.publishedDesktopVersions.flatMap((version) => {
    const normalized = normalizeStableDesktopVersion(version);
    if (!normalized) return [];
    const atOrAboveMinimum = compareVersions(normalized, input.metadata.minAppVersion);
    const atOrBelowLatest = compareVersions(normalized, input.metadata.latestAppVersion);
    return atOrAboveMinimum !== null && atOrAboveMinimum >= 0 && atOrBelowLatest !== null && atOrBelowLatest <= 0
      ? [normalized]
      : [];
  }))].sort((left, right) => compareVersions(left, right) ?? 0);
  const latestPublishedVersion = publishedVersions.at(-1);
  if (!latestPublishedVersion) return null;

  const restrictedVersions = Array.isArray(input.desktopConfig?.allowedDesktopVersions)
    ? input.desktopConfig.allowedDesktopVersions
    : null;
  const approvedPublishedVersions = restrictedVersions === null
    ? publishedVersions
    : publishedVersions.filter((publishedVersion) =>
        restrictedVersions.some((allowedVersion) => compareVersions(publishedVersion, allowedVersion) === 0),
      );
  const targetVersion = approvedPublishedVersions
    .filter((version) => compareVersions(version, currentVersion) === 1)
    .at(-1);

  if (targetVersion) {
    return { kind: "update", targetVersion, latestPublishedVersion };
  }

  if (compareVersions(latestPublishedVersion, currentVersion) === 1 && restrictedVersions !== null) {
    return { kind: "blocked", latestPublishedVersion };
  }

  return { kind: "current", latestPublishedVersion };
}

export async function resolveFreshStableDesktopUpdate(input: {
  currentVersion: string;
  refreshDesktopConfig: () => Promise<DenDesktopConfig>;
  readMetadata?: () => Promise<DenAppVersionMetadata>;
}): Promise<StableDesktopUpdateSelection | null> {
  const [desktopConfig, metadata] = await Promise.all([
    input.refreshDesktopConfig(),
    (input.readMetadata ?? readFreshDenAppVersionMetadata)(),
  ]);
  return selectStableDesktopUpdate({
    currentVersion: input.currentVersion,
    metadata,
    desktopConfig,
  });
}

export async function resolveAutomaticStableDesktopUpdate(input: {
  currentVersion: string;
  latestVersion: string;
  desktopConfig: DenDesktopConfig | null | undefined;
  readMetadata?: () => Promise<DenAppVersionMetadata>;
}): Promise<string | null> {
  if (!Array.isArray(input.desktopConfig?.allowedDesktopVersions)) return null;
  if (isUpdateAllowedByDesktopConfig(input.latestVersion, input.desktopConfig)) return null;

  try {
    const metadata = await (input.readMetadata ?? readFreshDenAppVersionMetadata)();
    const selection = selectStableDesktopUpdate({
      currentVersion: input.currentVersion,
      metadata,
      desktopConfig: input.desktopConfig,
    });
    return selection?.kind === "update" ? selection.targetVersion : null;
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
  if (!isAlphaChannelAllowedByDesktopConfig(desktopConfig)) return false;
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
