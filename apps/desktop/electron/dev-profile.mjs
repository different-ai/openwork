import { createHash } from "node:crypto";
import path from "node:path";

const WINDOWS_RESERVED_NAMES = new Set([
  "aux",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "con",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
  "nul",
  "prn",
]);

export function sanitizeDevProfileName(value) {
  const sanitized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .replace(/[._-]{2,}/g, "-");
  if (!sanitized) return "profile";
  if (WINDOWS_RESERVED_NAMES.has(sanitized)) return `${sanitized}-profile`;
  return sanitized;
}

export function deriveAutoDevProfileName(appRootPath) {
  const resolvedRoot = path.resolve(appRootPath);
  const hint = sanitizeDevProfileName(path.basename(resolvedRoot));
  const hash = createHash("sha256").update(resolvedRoot).digest("hex").slice(0, 10);
  return `${hint}-${hash}`;
}

export function resolveAppIdentifier({
  appIdentifierOverride,
  appRootPath,
  baseAppIdentifier,
  devAppIdentifier,
  devProfile,
  isDevMode,
  isPackaged,
}) {
  const explicitIdentifier = appIdentifierOverride?.trim();
  if (explicitIdentifier) return explicitIdentifier;
  if (!isDevMode || isPackaged) return baseAppIdentifier;

  const profile = devProfile?.trim();
  if (!profile) return baseAppIdentifier;

  const profileName = profile.toLowerCase() === "auto"
    ? deriveAutoDevProfileName(appRootPath)
    : sanitizeDevProfileName(profile);
  return `${devAppIdentifier}.${profileName}`;
}

export function resolveUserDataPath({ appDataPath, appIdentifier, userDataOverride }) {
  const explicitUserData = userDataOverride?.trim();
  if (explicitUserData) return explicitUserData;
  return path.join(appDataPath, appIdentifier);
}
