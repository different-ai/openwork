import { parseMcpAppResourceUri } from "@openwork/types/mcp-app";
import { readDenSettings } from "./den";
import { scheduleMcpAppDiscovery } from "./mcp-app-discovery-scheduler";
import type { OpenworkMcpAppLaunchReference, OpenworkMcpAppResource } from "./openwork-server";
import type { McpAppOrigin } from "../../components/chat/mcp-app-origin";
import { createPresentationCacheStore } from "../../react-app/domains/dashboard/dashboard-tile-cache";
import { DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "./dashboard-cache-storage";

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, "0")).join("");
}
const resourceDigest = (app: OpenworkMcpAppResource) => digest(JSON.stringify([app.html, app.csp, app.prefersBorder]));
type Scope = { key: string; current: () => boolean };

// Every account and workspace shares one storage key with a smaller budget than
// Dashboard tiles. Per-scope keys would add up to several full budgets (and orphan
// one per token rotation), exhausting localStorage for settings and Dashboard.
const CHAT_PRESENTATION_STORAGE_KEY = `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.chat`;
const CHAT_PRESENTATION_MAX_BYTES = 1_500_000;
const chatPresentationStore = createPresentationCacheStore(CHAT_PRESENTATION_MAX_BYTES);
const entryId = (scope: Scope, resourceUri: string) => `${scope.key}\n${resourceUri}`;

/** The account credential is hashed in memory; neither its value nor a lease goes into storage. */
export async function mcpAppPresentationScope(origin: McpAppOrigin): Promise<Scope | null> {
  const identity = () => {
    const settings = readDenSettings();
    return settings.authToken ? JSON.stringify([settings.authToken, settings.activeOrgId, settings.baseUrl,
      settings.apiBaseUrl, origin.client.baseUrl, origin.workspaceId]) : null;
  };
  const snapshot = identity();
  if (!snapshot) return null;
  return { key: await digest(snapshot), current: () => identity() === snapshot };
}

/** Reuse the bounded, 24-hour presentation store format and its authority-stripping parser. */
export function createMcpAppPresentationCache(scope: Scope, workspaceId: string) {
  return {
    async read(launch: OpenworkMcpAppLaunchReference): Promise<OpenworkMcpAppResource | null> {
      const revision = parseMcpAppResourceUri(launch.resourceUri);
      if (!scope.current() || !revision || !("connectionId" in launch) || revision.appId !== launch.connectionId) return null;
      const stored = chatPresentationStore.read(CHAT_PRESENTATION_STORAGE_KEY, entryId(scope, launch.resourceUri));
      if (!stored || stored.workspaceId !== workspaceId || stored.app.toolName !== launch.toolName
        || stored.app.resourceUri !== launch.resourceUri || stored.argumentsSignature !== await resourceDigest(stored.app)
        || !scope.current()) return null;
      return stored.app;
    },
    async write(launch: OpenworkMcpAppLaunchReference, app: OpenworkMcpAppResource) {
      const revision = parseMcpAppResourceUri(app.resourceUri);
      if (!revision || app.resourceUri !== launch.resourceUri || app.toolName !== launch.toolName
        || !("connectionId" in launch) || revision.appId !== launch.connectionId
        || !app.serverName.startsWith("openwork-app-host-connect-")) {
        chatPresentationStore.remove(CHAT_PRESENTATION_STORAGE_KEY, entryId(scope, launch.resourceUri));
        return;
      }
      const checksum = await resourceDigest(app);
      if (scope.current()) chatPresentationStore.write(CHAT_PRESENTATION_STORAGE_KEY, entryId(scope, app.resourceUri), {
        workspaceId, app, argumentsSignature: checksum, cachedAt: Date.now(), result: { content: [] },
      });
    },
    remove(launch: OpenworkMcpAppLaunchReference) { chatPresentationStore.remove(CHAT_PRESENTATION_STORAGE_KEY, entryId(scope, launch.resourceUri)); },
  };
}

/** Preview content immediately; discovery still owns a new live lease for every subscriber. */
export function scheduleCachedMcpAppDiscovery(
  origin: McpAppOrigin, toolName: string, launch: OpenworkMcpAppLaunchReference | null, manual: boolean,
  receive: (app: OpenworkMcpAppResource | null) => void, fail: (cause: unknown) => void,
  preview: (app: OpenworkMcpAppResource) => void,
  credentialRevision = 0,
  scope = mcpAppPresentationScope(origin),
) {
  let cancelled = false;
  let settled = false;
  const cache = scope.then(value => value ? createMcpAppPresentationCache(value, origin.workspaceId) : null).catch(() => null);
  const cancel = scheduleMcpAppDiscovery(origin, toolName, launch, manual, app => {
    settled = true;
    receive(app);
    if (launch) void cache.then(store => app ? store?.write(launch, app) : store?.remove(launch)).catch(() => undefined);
  }, cause => {
    settled = true;
    if (launch) void cache.then(store => store?.remove(launch)).catch(() => undefined);
    fail(cause);
  }, credentialRevision);
  if (launch) void cache.then(async store => {
    const app = await store?.read(launch);
    if (app && !cancelled && !settled) preview(app);
  }).catch(() => undefined);
  return () => { cancelled = true; cancel(); };
}
