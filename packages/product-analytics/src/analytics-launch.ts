const LAUNCH_STORAGE_KEY = "openwork.analytics.launch.v1";
const DAY_MS = 86_400_000;
type StorageAccess = Pick<Storage, "getItem" | "setItem">;

export function recordAnalyticsLaunch(storage: StorageAccess | undefined, now = Date.now()) {
  let runNumber = 1;
  let firstLaunchAt = now;
  try {
    const stored: unknown = JSON.parse(storage?.getItem(LAUNCH_STORAGE_KEY) ?? "null");
    if (stored && typeof stored === "object") {
      if ("runNumber" in stored && typeof stored.runNumber === "number" && Number.isSafeInteger(stored.runNumber) && stored.runNumber > 0 && stored.runNumber < Number.MAX_SAFE_INTEGER) {
        runNumber = stored.runNumber + 1;
      }
      if ("firstLaunchAt" in stored && typeof stored.firstLaunchAt === "number" && Number.isFinite(stored.firstLaunchAt) && stored.firstLaunchAt > 0 && stored.firstLaunchAt <= now) {
        firstLaunchAt = stored.firstLaunchAt;
      }
    }
  } catch {  }
  try {
    storage?.setItem(LAUNCH_STORAGE_KEY, JSON.stringify({ runNumber, firstLaunchAt }));
  } catch {  }
  return { runNumber, firstLaunchAt };
}

export function analyticsLaunchProperties(launch: ReturnType<typeof recordAnalyticsLaunch>, now = Date.now()) {
  return {
    run_number: launch.runNumber,
    install_age_days: Math.max(0, Math.floor((now - launch.firstLaunchAt) / DAY_MS)),
  };
}

export function analyticsRuntimeProperties(meta: { platform?: string; arch?: string; isPackaged?: boolean } | undefined, officialRelease: boolean, fallbackPlatform: string) {
  const platform = meta?.platform ?? fallbackPlatform;
  const os = /^(darwin|mac)/i.test(platform) ? "mac"
    : /^(win|windows)/i.test(platform) ? "windows"
      : /^linux/i.test(platform) ? "linux" : "other";
  const arch = meta?.arch;
  return {
    official_build: officialRelease && meta?.isPackaged === true,
    os,
    arch: arch === "arm64" || arch === "x64" || arch === "ia32" || arch === "arm" ? arch : "other",
  };
}
