import { BUILD_LATEST_APP_VERSION } from "./generated/app-version.js";

const MIN_APP_VERSION = "0.11.207";

function normalizeVersion(value: string | undefined | null) {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export const denApiAppVersion = {
  minAppVersion: MIN_APP_VERSION,
  latestAppVersion: normalizeVersion(BUILD_LATEST_APP_VERSION) ?? "0.0.0",
} as const;
