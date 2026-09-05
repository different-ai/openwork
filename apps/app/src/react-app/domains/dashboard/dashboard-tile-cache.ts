import type { OpenworkMcpAppResource } from "@/app/lib/openwork-server";
import { DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import type { PreservedMcpAppResult } from "@/components/chat/mcp-app-frame";

const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_CACHE_BYTES = 3_000_000;
export const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export type DashboardTileCache = {
  cachedAt: number;
  workspaceId: string;
  app: OpenworkMcpAppResource;
  result: PreservedMcpAppResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseApp(value: unknown): OpenworkMcpAppResource | null {
  if (!isRecord(value) || !isRecord(value.csp)) return null;
  if (
    typeof value.serverName !== "string"
    || typeof value.toolName !== "string"
    || typeof value.resourceUri !== "string"
    || typeof value.html !== "string"
    || typeof value.prefersBorder !== "boolean"
    || !isStringArray(value.csp.connectDomains)
    || !isStringArray(value.csp.resourceDomains)
    || !isStringArray(value.csp.frameDomains)
    || !isStringArray(value.csp.baseUriDomains)
  ) return null;
  return {
    serverName: value.serverName,
    toolName: value.toolName,
    resourceUri: value.resourceUri,
    html: value.html,
    prefersBorder: value.prefersBorder,
    csp: {
      connectDomains: value.csp.connectDomains,
      resourceDomains: value.csp.resourceDomains,
      frameDomains: value.csp.frameDomains,
      baseUriDomains: value.csp.baseUriDomains,
    },
  };
}

function parseResult(value: unknown): PreservedMcpAppResult | null {
  if (!isRecord(value) || !Array.isArray(value.content) || !value.content.every(isRecord)) return null;
  if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) return null;
  if (value._meta !== undefined && !isRecord(value._meta)) return null;
  return {
    content: value.content,
    ...(value.structuredContent ? { structuredContent: value.structuredContent } : {}),
    ...(value._meta ? { _meta: value._meta } : {}),
  };
}

function parseCache(value: unknown, now: number): DashboardTileCache | null {
  if (!isRecord(value) || typeof value.cachedAt !== "number" || !Number.isFinite(value.cachedAt)) return null;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  if (value.cachedAt <= 0 || now - value.cachedAt > MAX_CACHE_AGE_MS) return null;
  const app = parseApp(value.app);
  const result = parseResult(value.result);
  return app && result ? { cachedAt: value.cachedAt, workspaceId: value.workspaceId, app, result } : null;
}

export function dashboardTileCacheScopeKey(userId: string | null, organizationId: string | null): string {
  return `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.${userId?.trim() || "local"}.${organizationId?.trim() || "none"}`;
}

export function dashboardTileRunsAutomatically(
  requiresApproval: boolean,
  autoLaunchEnabled: boolean,
  launchApproved: boolean,
  organizationAutoLaunch: boolean,
): boolean {
  return organizationAutoLaunch || (!requiresApproval && autoLaunchEnabled && !launchApproved);
}

/** Admin policy is an independent server-authored approval for this managed element. */
export function dashboardTileLaunchIsApproved(
  organizationAutoLaunch: boolean,
  memberApproved: boolean,
): boolean {
  return organizationAutoLaunch || memberApproved;
}

export function shouldAutoRefreshDashboardTile(input: {
  visible: boolean;
  refreshing: boolean;
  lastRefreshAt: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return input.visible
    && !input.refreshing
    && now - input.lastRefreshAt >= DASHBOARD_AUTO_REFRESH_INTERVAL_MS;
}

export function readDashboardTileCache(
  scopeKey: string,
  entryId: string,
  now = Date.now(),
): DashboardTileCache | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(scopeKey);
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parseCache(parsed[entryId], now) : null;
  } catch {
    return null;
  }
}

export function writeDashboardTileCache(
  scopeKey: string,
  entryId: string,
  cache: DashboardTileCache,
) {
  if (typeof window === "undefined") return;
  try {
    const raw = window.localStorage.getItem(scopeKey);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    const next: Record<string, unknown> = isRecord(parsed) ? { ...parsed } : {};
    next[entryId] = cache;

    const entries = Object.entries(next).sort((left, right) => {
      const leftAt = isRecord(left[1]) && typeof left[1].cachedAt === "number" ? left[1].cachedAt : 0;
      const rightAt = isRecord(right[1]) && typeof right[1].cachedAt === "number" ? right[1].cachedAt : 0;
      return leftAt - rightAt;
    });
    let serialized = JSON.stringify(Object.fromEntries(entries));
    while (serialized.length > MAX_SCOPE_CACHE_BYTES && entries.length > 1) {
      entries.shift();
      serialized = JSON.stringify(Object.fromEntries(entries));
    }
    if (serialized.length <= MAX_SCOPE_CACHE_BYTES) window.localStorage.setItem(scopeKey, serialized);
  } catch {
    // Caching is best-effort. A live result still renders when storage is unavailable.
  }
}
