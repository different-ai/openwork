import type { DesktopFreeVersionError } from "./protocol.js";

/**
 * Which desktop releases may use signed-out Auto: the newest `count` stable
 * releases plus any stable release published within `minDays`, minus blocked
 * ones. Prereleases never qualify.
 */
const identifier = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const semver = new RegExp(`^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${identifier}(?:\\.${identifier})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);
export function parseDesktopVersion(value: string): { core: number[]; prerelease: string | undefined } | null {
  if (value.length > 128) return null;
  const match = semver.exec(value);
  if (!match || match[0] !== value) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part)) || core.every((part) => part === 0)) return null;
  return { core, prerelease: match[4] };
}
/** -1, 0 or 1; a prerelease sorts before its release. Null when either side is not a desktop version. */
export function compareDesktopVersions(a: string, b: string): number | null {
  const left = parseDesktopVersion(a), right = parseDesktopVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index++) {
    const comparison = Math.sign(left.core[index] - right.core[index]);
    if (comparison !== 0) return comparison;
  }
  return Number(Boolean(right.prerelease)) - Number(Boolean(left.prerelease));
}

export type DesktopRelease = { version: string; publishedAt: number };
export type DesktopReleaseWindow = { count: number; minDays: number; blocked: readonly string[] };
export function supportedDesktopReleases(releases: readonly DesktopRelease[], window: DesktopReleaseWindow, now = Date.now()): string[] {
  const stable = releases
    .filter((release) => { const parsed = parseDesktopVersion(release.version); return parsed && !parsed.prerelease && Number.isFinite(release.publishedAt); })
    .sort((a, b) => compareDesktopVersions(b.version, a.version) ?? 0);
  const floor = now - window.minDays * 86400000;
  const supported = stable.filter((release, index) => index < window.count || release.publishedAt >= floor);
  return [...new Set(supported.map((release) => release.version))].filter((version) => !window.blocked.includes(version));
}
export function lowestDesktopVersion(versions: readonly string[]): string | null {
  return versions.length ? versions.reduce((lowest, version) => (compareDesktopVersions(version, lowest) ?? 0) < 0 ? version : lowest) : null;
}
export function desktopFreeVersionError(currentVersion: string, supported: readonly string[] | null): DesktopFreeVersionError | null {
  const minimumVersion = supported ? lowestDesktopVersion(supported) : null;
  if (!minimumVersion) return { code: "desktop_version_unavailable", currentVersion, minimumVersion: null,
    message: "The supported desktop version cannot be verified. Auto is temporarily unavailable." };
  if (!supported?.includes(currentVersion)) return { code: "desktop_update_required", currentVersion, minimumVersion,
    message: `Update OpenWork Desktop to ${minimumVersion} or newer to use Auto.` };
  return null;
}
/** v2 proofs (no release tag) are accepted only while a release that predates tags is still supported. */
export function releaseTagRequired(supported: readonly string[], firstReleaseTagVersion: string | null): boolean {
  if (!firstReleaseTagVersion) return false;
  return supported.every((version) => (compareDesktopVersions(version, firstReleaseTagVersion) ?? -1) >= 0);
}
/**
 * Accepts GitHub's `/releases` list (drafts and prereleases skipped) or
 * `{ releases: [{ version, publishedAt }] }`. Any malformed entry rejects the whole list.
 */
export function parseDesktopReleases(value: unknown): DesktopRelease[] | null {
  const entries = Array.isArray(value) ? value
    : typeof value === "object" && value !== null && "releases" in value && Array.isArray(value.releases) ? value.releases : null;
  if (!entries) return null;
  const releases: DesktopRelease[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) return null;
    if ("tag_name" in entry) {
      if (typeof entry.tag_name !== "string" || !("draft" in entry) || !("prerelease" in entry) || !("published_at" in entry)) return null;
      if (entry.draft !== false || entry.prerelease !== false || typeof entry.published_at !== "string") continue;
      const publishedAt = Date.parse(entry.published_at);
      if (Number.isFinite(publishedAt)) releases.push({ version: entry.tag_name.replace(/^v/, ""), publishedAt });
    } else if ("version" in entry && "publishedAt" in entry && typeof entry.version === "string" && typeof entry.publishedAt === "string") {
      const publishedAt = Date.parse(entry.publishedAt);
      if (Number.isFinite(publishedAt)) releases.push({ version: entry.version.replace(/^v/, ""), publishedAt });
    } else return null;
  }
  return releases;
}
