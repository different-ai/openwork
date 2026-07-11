import type { AppBuildInfo } from "@openwork/types/desktop-ipc";
import { appBuildInfo } from "./desktop";
import { isDesktopRuntime } from "../utils";

// Cached once at startup (index.react.tsx) so gates and boot logic can read
// build facts synchronously, mirroring the desktop-bootstrap snapshot pattern.
let cached: AppBuildInfo | null = null;

export async function initializeAppBuildInfo(): Promise<AppBuildInfo | null> {
  if (!isDesktopRuntime() || cached) {
    return cached;
  }
  try {
    cached = await appBuildInfo();
  } catch {
    cached = null;
  }
  return cached;
}

export function readAppBuildInfo(): AppBuildInfo | null {
  return cached;
}

/** True when running the network-neutral enterprise installer flavor. */
export function isEnterpriseBuild(): boolean {
  return cached?.enterprise === true;
}
