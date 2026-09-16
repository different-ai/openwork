import type { OpenworkMcpAppResource } from "@/app/lib/openwork-server";
import { createDashboardTileCacheStore, DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import type { PreservedMcpAppResult } from "@/components/chat/mcp-app-frame";

const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_CACHE_BYTES = 3_000_000;
export const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export type DashboardTileCache = {
  argumentsSignature?: string;
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
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
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
  return app && result ? {
    cachedAt: value.cachedAt, workspaceId: value.workspaceId, app, result,
    ...(typeof value.argumentsSignature === "string" ? { argumentsSignature: value.argumentsSignature } : {}),
  } : null;
}

// Tiles from one App host usually share a single large HTML resource. Storing
// that resource once per scope keeps every tile inside the size budget instead
// of evicting the oldest results as soon as a few tiles are added.
const SHARED_HTML_KEY = "$html";
const SHARED_ENTRIES_KEY = "$entries";

function parseScope(value: unknown, now: number): Map<string, DashboardTileCache> {
  const scope = new Map<string, DashboardTileCache>();
  if (!isRecord(value)) return scope;
  const shared = isRecord(value[SHARED_HTML_KEY]) ? value[SHARED_HTML_KEY] : null;
  const entries = shared && isRecord(value[SHARED_ENTRIES_KEY]) ? value[SHARED_ENTRIES_KEY] : value;
  for (const [entryId, entry] of Object.entries(entries)) {
    if (!shared && (entryId === SHARED_HTML_KEY || entryId === SHARED_ENTRIES_KEY)) continue;
    let candidate: unknown = entry;
    if (shared && isRecord(entry) && isRecord(entry.app) && typeof entry.app.htmlRef === "string") {
      const html = shared[entry.app.htmlRef];
      if (typeof html !== "string") continue;
      const { htmlRef: _ref, ...app } = entry.app;
      candidate = { ...entry, app: { ...app, html } };
    }
    const cache = parseCache(candidate, now);
    if (cache) scope.set(entryId, cache);
  }
  return scope;
}

function htmlRefFor(html: string, refs: Map<string, string>): string {
  let ref = refs.get(html);
  if (ref === undefined) {
    ref = `h${refs.size}`;
    refs.set(html, ref);
  }
  return ref;
}

function serializeScope(scope: Map<string, DashboardTileCache>, now: number): string | null {
  // Newest first so the freshest tiles survive eviction; shared HTML is
  // charged once, when its first referencing entry is kept.
  const ordered = [...scope].sort((left, right) => right[1].cachedAt - left[1].cachedAt);
  const refs = new Map<string, string>();
  const kept: Array<{ entryId: string; serialized: string }> = [];
  const keptHtml = new Set<string>();
  let size = `{"${SHARED_HTML_KEY}":{},"${SHARED_ENTRIES_KEY}":{}}`.length;
  for (const [entryId, value] of ordered) {
    const cache = parseCache(value, now);
    if (!cache) {
      scope.delete(entryId);
      continue;
    }
    const ref = htmlRefFor(cache.app.html, refs);
    let serialized: string;
    let htmlCost = 0;
    try {
      const { html, ...app } = cache.app;
      serialized = `${JSON.stringify(entryId)}:${JSON.stringify({ ...cache, app: { ...app, htmlRef: ref } })}`;
      if (!keptHtml.has(ref)) htmlCost = `${JSON.stringify(ref)}:${JSON.stringify(html)},`.length;
    } catch {
      scope.delete(entryId);
      continue;
    }
    const cost = serialized.length + 1 + htmlCost;
    if (size + cost > MAX_SCOPE_CACHE_BYTES) {
      scope.delete(entryId);
      continue;
    }
    size += cost;
    keptHtml.add(ref);
    scope.set(entryId, cache);
    kept.push({ entryId, serialized });
  }
  if (kept.length === 0) return null;
  const htmlEntries = [...refs].filter(([, ref]) => keptHtml.has(ref))
    .map(([html, ref]) => `${JSON.stringify(ref)}:${JSON.stringify(html)}`);
  return `{${JSON.stringify(SHARED_HTML_KEY)}:{${htmlEntries.join(",")}},${JSON.stringify(SHARED_ENTRIES_KEY)}:{${kept.map((entry) => entry.serialized).join(",")}}}`;
}

const cacheStore = createDashboardTileCacheStore(parseScope, serializeScope);

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
  const scope = cacheStore.read(scopeKey, now);
  const cache = scope?.get(entryId);
  if (!scope || !cache) return null;
  if (now - cache.cachedAt > MAX_CACHE_AGE_MS) {
    scope.delete(entryId);
    cacheStore.schedule(scopeKey);
    return null;
  }
  return cache;
}

export function writeDashboardTileCache(
  scopeKey: string,
  entryId: string,
  cache: DashboardTileCache,
): void {
  const next = parseCache(cache, Date.now());
  if (!next) return;
  const scope = cacheStore.read(scopeKey);
  if (!scope) return;
  scope.set(entryId, next);
  cacheStore.schedule(scopeKey);
}

export function removeDashboardTileCache(scopeKey: string, entryId: string): void {
  const scope = cacheStore.read(scopeKey);
  if (!scope) return;
  scope.delete(entryId);
  cacheStore.schedule(scopeKey);
}
