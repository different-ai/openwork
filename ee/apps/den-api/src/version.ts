import { BUILD_LATEST_APP_VERSION } from "./generated/app-version.js";
import { MIN_SUPPORTED_DESKTOP_VERSION, PUBLISHED_DESKTOP_VERSIONS } from "./generated/desktop-versions.js";

function normalizeVersion(value: string | undefined | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

const latestPublishedDesktopVersion = normalizeVersion(PUBLISHED_DESKTOP_VERSIONS[0]);
const buildLatestAppVersion = normalizeVersion(BUILD_LATEST_APP_VERSION);

export const denApiAppVersion = {
  minAppVersion: MIN_SUPPORTED_DESKTOP_VERSION,
  latestAppVersion: latestPublishedDesktopVersion ?? buildLatestAppVersion ?? "0.0.0",
} as const;
