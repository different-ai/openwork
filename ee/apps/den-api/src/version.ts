import { BUILD_LATEST_APP_VERSION } from "./generated/app-version.js";
import { MIN_SUPPORTED_DESKTOP_VERSION } from "./generated/desktop-versions.js";

function normalizeVersion(value: string | undefined | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export const denApiAppVersion = {
  minAppVersion: MIN_SUPPORTED_DESKTOP_VERSION,
  latestAppVersion: normalizeVersion(BUILD_LATEST_APP_VERSION) ?? "0.0.0",
} as const;
