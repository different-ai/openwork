import { OPENWORK_EXTENSION_CATALOG } from "@/app/constants";
import { desktopBridge } from "@/app/lib/desktop";
import { isMacPlatform } from "@/app/utils";
import { isOpenWorkExtensionEnabled, isOpenWorkExtensionHidden } from "@/react-app/domains/settings/extension-state";

/**
 * "@App" mentions let the user target a running macOS app for Computer Use
 * straight from the composer (e.g. "@Music"). They are only offered when:
 * - running inside the Electron desktop shell on macOS, and
 * - the Computer Use extension is enabled (it is macOS-only and opt-in).
 */
export function isAppMentionAvailable(): boolean {
  if (typeof window === "undefined" || !window.__OPENWORK_ELECTRON__?.invokeDesktop) return false;
  if (!isMacPlatform()) return false;
  const entry = OPENWORK_EXTENSION_CATALOG.find((candidate) => candidate.id === "computer-use");
  if (!entry) return false;
  return isOpenWorkExtensionEnabled(entry) && !isOpenWorkExtensionHidden(entry);
}

/**
 * Instruction text sent to the model for a composer "@App" mention. Steers the
 * agent to the Computer Use MCP tools and an explicit snapshot of the named
 * app instead of assuming the app is frontmost.
 */
export function appMentionInstruction(appName: string) {
  return `[The user mentioned the macOS app "${appName}". Use the computer-use tools to see and operate it: start with snapshot {"app": "${appName}"} — do not assume it is the frontmost app. Prefer semantic refs from the snapshot over coordinates.]`;
}

type ListRunningAppsResult = { ok?: boolean; apps?: unknown };

let appsCache: { at: number; apps: string[] } | null = null;
const APPS_CACHE_TTL_MS = 10_000;

/** List running regular macOS apps for the mention menu. Cached briefly; never throws. */
export async function listRunningAppsForMention(): Promise<string[]> {
  if (!isAppMentionAvailable()) return [];
  if (appsCache && Date.now() - appsCache.at < APPS_CACHE_TTL_MS) return appsCache.apps;
  try {
    const result = (await desktopBridge.listRunningApps()) as ListRunningAppsResult;
    const apps = Array.isArray(result.apps)
      ? result.apps.filter((name): name is string => typeof name === "string" && name.trim().length > 0)
      : [];
    appsCache = { at: Date.now(), apps };
    return apps;
  } catch {
    return [];
  }
}
