import { MCP_APP_INITIAL_RESULTS_META } from "@openwork/types/mcp-app";
import type { OpenworkMcpAppResource } from "@/app/lib/openwork-server";
import { createDashboardTileCacheStore, DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import { mcpAppDocuments } from "@/app/lib/mcp-app-document-store";
import type { PreservedMcpAppResult } from "@/components/chat/mcp-app-frame";

const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_CACHE_BYTES = 3_000_000;
export const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;
const MAX_STORED_READ_BYTES = 200_000;
const MAX_STORED_READS_BYTES = 256 * 1024;

/** A read an App made, kept in the shape of launch data so the App can show it as it next starts. */
export type DashboardTileStoredRead = {
  name: string;
  arguments: Record<string, unknown>;
  loadedAt: string;
  providerIdentity: string;
  result: { content: Array<Record<string, unknown>>; structuredContent?: Record<string, unknown> };
};

export type DashboardTileCache = {
  argumentsSignature?: string;
  cachedAt: number;
  workspaceId: string;
  app: OpenworkMcpAppResource;
  result: PreservedMcpAppResult;
  storedReads?: DashboardTileStoredRead[];
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
    || (value.html !== undefined && typeof value.html !== "string")
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
    // Empty until its document comes back from IndexedDB.
    html: value.html ?? "",
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

function parseStoredReads(value: unknown): DashboardTileStoredRead[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): DashboardTileStoredRead[] => {
    if (!isRecord(item) || typeof item.name !== "string" || !isRecord(item.arguments) || typeof item.loadedAt !== "string"
      || typeof item.providerIdentity !== "string" || !isRecord(item.result)
      || !Array.isArray(item.result.content) || !item.result.content.every(isRecord)) return [];
    const { structuredContent } = item.result;
    return [{
      name: item.name, arguments: item.arguments, loadedAt: item.loadedAt, providerIdentity: item.providerIdentity,
      result: { content: item.result.content, ...(isRecord(structuredContent) ? { structuredContent } : {}) },
    }];
  });
}

function parseCache(value: unknown, now: number): DashboardTileCache | null {
  if (!isRecord(value) || typeof value.cachedAt !== "number" || !Number.isFinite(value.cachedAt)) return null;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  if (value.cachedAt <= 0 || now - value.cachedAt > MAX_CACHE_AGE_MS) return null;
  const app = parseApp(value.app);
  const result = parseResult(value.result);
  const storedReads = parseStoredReads(value.storedReads);
  return app && result ? {
    cachedAt: value.cachedAt, workspaceId: value.workspaceId, app, result,
    ...(typeof value.argumentsSignature === "string" ? { argumentsSignature: value.argumentsSignature } : {}),
    ...(storedReads.length ? { storedReads } : {}),
  } : null;
}

// Saved App documents live in IndexedDB. Older entries kept them here, shared
// between tiles, and still parse.
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

function serializeScope(scope: Map<string, DashboardTileCache>, now: number, maxBytes = MAX_SCOPE_CACHE_BYTES): string | null {
  // Newest first so the freshest tiles survive eviction.
  const ordered = [...scope].sort((left, right) => right[1].cachedAt - left[1].cachedAt);
  const kept: Array<{ entryId: string; serialized: string }> = [];
  let size = `{"${SHARED_HTML_KEY}":{},"${SHARED_ENTRIES_KEY}":{}}`.length;
  for (const [entryId, value] of ordered) {
    const cache = parseCache(value, now);
    if (!cache) {
      scope.delete(entryId);
      continue;
    }
    let serialized: string;
    try {
      const { html: _document, ...app } = cache.app;
      serialized = `${JSON.stringify(entryId)}:${JSON.stringify({ ...cache, app })}`;
    } catch {
      scope.delete(entryId);
      continue;
    }
    const cost = serialized.length + 1;
    if (size + cost > maxBytes) {
      scope.delete(entryId);
      continue;
    }
    size += cost;
    scope.set(entryId, cache);
    kept.push({ entryId, serialized });
  }
  if (kept.length === 0) return null;
  return `{${JSON.stringify(SHARED_HTML_KEY)}:{},${JSON.stringify(SHARED_ENTRIES_KEY)}:{${kept.map((entry) => entry.serialized).join(",")}}}`;
}

/** A bounded presentation store; each instance owns its own per-key byte budget. */
export function createPresentationCacheStore(maxBytes: number) {
  const store = createDashboardTileCacheStore(parseScope, (scope: Map<string, DashboardTileCache>, now: number) => serializeScope(scope, now, maxBytes));
  return {
    read(scopeKey: string, entryId: string, now = Date.now()): DashboardTileCache | null {
      const scope = store.read(scopeKey, now);
      const cache = scope?.get(entryId);
      if (!scope || !cache) return null;
      if (now - cache.cachedAt > MAX_CACHE_AGE_MS) {
        scope.delete(entryId);
        store.schedule(scopeKey);
        void mcpAppDocuments.remove(scopeKey, entryId);
        return null;
      }
      return cache.app.html ? cache : null;
    },
    /** Whether this entry's App document has yet to come back from IndexedDB. */
    documentPending(scopeKey: string, entryId: string): boolean {
      const cache = store.read(scopeKey)?.get(entryId);
      return cache !== undefined && !cache.app.html;
    },
    async loadDocument(scopeKey: string, entryId: string): Promise<void> {
      const waiting = store.read(scopeKey)?.get(entryId);
      if (!waiting || waiting.app.html) return;
      const html = await mcpAppDocuments.read(scopeKey, entryId);
      const scope = store.read(scopeKey);
      if (html && scope?.get(entryId) === waiting) scope.set(entryId, { ...waiting, app: { ...waiting.app, html } });
    },
    write(scopeKey: string, entryId: string, cache: DashboardTileCache): void {
      const next = parseCache(cache, Date.now());
      if (!next) return;
      const scope = store.read(scopeKey);
      if (!scope) return;
      const previous = scope.get(entryId);
      // Stored reads must be supplied with a verified current provider identity; do not inherit them here.
      scope.set(entryId, next);
      store.schedule(scopeKey);
      if (previous?.app.html !== next.app.html) void mcpAppDocuments.save(scopeKey, entryId, next.app.html);
    },
    /** Sets exactly this entry, inheriting nothing from the one it replaces. */
    replace(scopeKey: string, entryId: string, cache: DashboardTileCache): void {
      const scope = store.read(scopeKey);
      if (!scope) return;
      scope.set(entryId, cache);
      store.schedule(scopeKey);
    },
    remove(scopeKey: string, entryId: string): void {
      const scope = store.read(scopeKey);
      if (!scope) return;
      scope.delete(entryId);
      store.schedule(scopeKey);
      void mcpAppDocuments.remove(scopeKey, entryId);
    },
  };
}

const cacheStore = createPresentationCacheStore(MAX_SCOPE_CACHE_BYTES);

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
  return cacheStore.read(scopeKey, entryId, now);
}

export function writeDashboardTileCache(
  scopeKey: string,
  entryId: string,
  cache: DashboardTileCache,
): void {
  cacheStore.write(scopeKey, entryId, cache);
}

export function removeDashboardTileCache(scopeKey: string, entryId: string): void {
  cacheStore.remove(scopeKey, entryId);
}

const sameRead = (left: { name: string; arguments?: unknown }, right: { name: string; arguments?: unknown }) =>
  left.name === right.name && JSON.stringify(left.arguments ?? {}) === JSON.stringify(right.arguments ?? {});

/**
 * Stores what an App just loaded, or with no kept result forgets it: a failed
 * read may mean this person can no longer see it. A result from another
 * account drops every earlier read, so reconnecting leaves nothing behind.
 */
export function rememberDashboardTileRead(
  scopeKey: string,
  entryId: string,
  read: { name: string; arguments: Record<string, unknown> },
  kept: { providerIdentity: string; result: PreservedMcpAppResult } | null,
  now = Date.now(),
): void {
  const cache = readDashboardTileCache(scopeKey, entryId, now);
  if (!cache) return;
  const others = (cache.storedReads ?? []).filter((item) => !sameRead(item, read)
    && (!kept || item.providerIdentity === kept.providerIdentity));
  const stored: DashboardTileStoredRead | null = kept ? {
    ...read, loadedAt: new Date(now).toISOString(), providerIdentity: kept.providerIdentity,
    result: { content: kept.result.content, ...(kept.result.structuredContent ? { structuredContent: kept.result.structuredContent } : {}) },
  } : null;
  const newest = stored && JSON.stringify(stored).length <= MAX_STORED_READ_BYTES ? [stored] : [];
  const storedReads = [...others, ...newest];
  while (JSON.stringify(storedReads).length > MAX_STORED_READS_BYTES) storedReads.shift();
  const { storedReads: _replaced, ...rest } = cache;
  // Written directly: an empty list must clear the reads, not inherit them.
  cacheStore.replace(scopeKey, entryId, storedReads.length ? { ...rest, storedReads } : rest);
}

/** The saved launch result with what the App last loaded, newest first, so it shows that data as it starts. */
export function savedLaunchResult(cache: Pick<DashboardTileCache, "result" | "storedReads">): PreservedMcpAppResult {
  if (!cache.storedReads?.length) return cache.result;
  const launched = cache.result._meta?.[MCP_APP_INITIAL_RESULTS_META];
  const launchData = (Array.isArray(launched) ? launched : []).filter((item): item is { name: string; arguments?: unknown; loadedAt?: unknown } =>
    isRecord(item) && typeof item.name === "string");
  const reads = cache.storedReads.filter((read) => {
    const newer = launchData.find((item) => sameRead(item, read));
    return !newer || typeof newer.loadedAt !== "string" || Date.parse(newer.loadedAt) < Date.parse(read.loadedAt);
  });
  const shown = reads.map(({ providerIdentity: _server, ...read }) => read);
  return { ...cache.result, _meta: { ...cache.result._meta,
    [MCP_APP_INITIAL_RESULTS_META]: [...shown, ...launchData.filter((item) => !reads.some((read) => sameRead(item, read)))] } };
}

export function dashboardTileDocumentPending(scopeKey: string, entryId: string): boolean {
  return cacheStore.documentPending(scopeKey, entryId);
}

export function loadDashboardTileDocument(scopeKey: string, entryId: string): Promise<void> {
  return cacheStore.loadDocument(scopeKey, entryId);
}
