import type { DesktopFreeVersionError } from "./protocol.js";

/**
 * The desktop reports its version in the signed proof, like a user agent. Every
 * version may use signed-out Auto unless the server says otherwise: a blocked
 * version, or one below a configured minimum, is asked to update.
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

export type DesktopVersionPolicy = { minimumVersion: string | null; blocked: readonly string[] };
export function desktopFreeVersionError(currentVersion: string, policy: DesktopVersionPolicy): DesktopFreeVersionError | null {
  // Blocked versions are listed without build metadata ("1.2.4-alpha.3244", not "…+4d3cfbd").
  const plus = currentVersion.indexOf("+");
  const withoutBuild = plus >= 0 ? currentVersion.slice(0, plus) : currentVersion;
  const { minimumVersion } = policy;
  const blocked = policy.blocked.includes(withoutBuild);
  const belowMinimum = minimumVersion !== null && (compareDesktopVersions(currentVersion, minimumVersion) ?? -1) < 0;
  if (!blocked && !belowMinimum) return null;
  return { code: "desktop_update_required", currentVersion, minimumVersion,
    message: minimumVersion ? `Update OpenWork Desktop to ${minimumVersion} or newer to use Auto.` : "Update OpenWork Desktop to use Auto." };
}
