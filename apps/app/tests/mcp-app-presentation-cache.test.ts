import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mcpAppResourceUri } from "@openwork/types/mcp-app";
import { createMcpAppPresentationCache, mcpAppPresentationScope, scheduleCachedMcpAppDiscovery } from "../src/app/lib/mcp-app-presentation-cache";
import { createOpenworkServerClient, type OpenworkMcpAppResource } from "../src/app/lib/openwork-server";
import { setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import { flushDashboardTileCacheStorage, resetDashboardTileCacheMemory } from "../src/app/lib/dashboard-cache-storage";
import { createPresentationCacheStore } from "../src/react-app/domains/dashboard/dashboard-tile-cache";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
afterEach(() => { resetDashboardTileCacheMemory(); window.localStorage.clear(); });
const appId = `cob_01mcpapp${"a".repeat(18)}`;
const uri = mcpAppResourceUri(appId, `cov_01mcpapp${"b".repeat(18)}`);
const nextUri = mcpAppResourceUri(appId, `cov_01mcpapp${"c".repeat(18)}`);
const app: OpenworkMcpAppResource = { launchId: "private-live-lease", refresh: { resourceDigest: "a".repeat(64), expiresAt: Date.now() + 60_000 },
  serverName: "openwork-app-host-connect-fixture", toolName: "open_app", resourceUri: uri, html: "<main>Cached App</main>",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: false };
const launch = { connectionId: appId, toolName: app.toolName, resourceUri: uri, arguments: {} };
const scope = { key: "user-a", current: () => true };
const CHAT_STORAGE_KEY = "openwork.react.dashboardTileCache.v1.chat";
const origin = { client: createOpenworkServerClient({ baseUrl: "http://localhost:8787" }), workspaceId: "workspace-a", sessionId: "session-a", readOnly: false };

test("miss, hit and device reload retain immutable HTML but never authority", async () => {
  const cache = createMcpAppPresentationCache(scope, origin.workspaceId);
  expect(await cache.read(launch)).toBeNull();
  await cache.write(launch, app);
  expect(await cache.read(launch)).toMatchObject({ html: app.html });
  expect((await cache.read(launch))?.launchId).toBeUndefined();
  expect((await cache.read(launch))?.refresh).toBeUndefined();
  expect(await cache.read({ ...launch, connectionId: "other-provider" })).toBeNull();
  flushDashboardTileCacheStorage(); resetDashboardTileCacheMemory();
  expect((await cache.read(launch))?.html).toBe(app.html);
});
test("a new revision invalidates the old binding and is a separate miss", async () => {
  const cache = createMcpAppPresentationCache(scope, origin.workspaceId);
  await cache.write(launch, app);
  expect(await cache.read({ ...launch, resourceUri: nextUri })).toBeNull();
  await cache.write(launch, { ...app, resourceUri: nextUri });
  expect(await cache.read(launch)).toBeNull();
  await cache.write({ ...launch, resourceUri: nextUri }, { ...app, resourceUri: nextUri, html: "<main>New revision</main>" });
  expect((await cache.read({ ...launch, resourceUri: nextUri }))?.html).toContain("New revision");
});
test("principals and workspaces never share presentation content; a changed account retires pending reads", async () => {
  await createMcpAppPresentationCache(scope, origin.workspaceId).write(launch, app);
  expect(await createMcpAppPresentationCache({ ...scope, key: `${scope.key}.other-user` }, origin.workspaceId).read(launch)).toBeNull();
  expect(await createMcpAppPresentationCache(scope, "other-workspace").read(launch)).toBeNull();
  expect(await createMcpAppPresentationCache({ ...scope, current: () => false }, origin.workspaceId).read(launch)).toBeNull();
});
test("corrupt HTML cannot paint under a previous digest", async () => {
  createPresentationCacheStore(1_500_000).write(CHAT_STORAGE_KEY, `${scope.key}\n${uri}`, { workspaceId: origin.workspaceId,
    cachedAt: Date.now(), app, argumentsSignature: "wrong-digest", result: { content: [] } });
  flushDashboardTileCacheStorage(); resetDashboardTileCacheMemory();
  expect(await createMcpAppPresentationCache(scope, origin.workspaceId).read(launch)).toBeNull();
});
test("every account and workspace shares one bounded storage entry", async () => {
  const html = `<main>${"x".repeat(400_000)}</main>`;
  for (const [index, workspaceId] of ["workspace-a", "workspace-b", "workspace-c", "workspace-d", "workspace-e"].entries()) {
    const revisionUri = mcpAppResourceUri(appId, `cov_01mcpapp${String(index).repeat(18)}`);
    await createMcpAppPresentationCache({ ...scope, key: `user-${index}` }, workspaceId).write(
      { ...launch, resourceUri: revisionUri }, { ...app, resourceUri: revisionUri, html: `${html}${index}` });
  }
  flushDashboardTileCacheStorage();
  const keys = Object.keys(window.localStorage).filter(key => key.startsWith("openwork.react.dashboardTileCache.v1."));
  expect(keys).toEqual([CHAT_STORAGE_KEY]);
  expect(window.localStorage.getItem(CHAT_STORAGE_KEY)!.length).toBeLessThanOrEqual(1_500_000);
});
test("account scopes contain no credential and rotate with user, organization and endpoint", async () => {
  const desktop = window.__OPENWORK_ELECTRON__;
  delete window.__OPENWORK_ELECTRON__;
  try {
    const settings = { baseUrl: "http://localhost:3005", apiBaseUrl: "http://localhost:8789", authToken: "synthetic-user-a-token", activeOrgId: "org-a" };
    await setDenBootstrapConfig(settings);
    writeDenSettings(settings, { persistBootstrap: true });
    const first = await mcpAppPresentationScope(origin);
    expect(first?.key).not.toContain(settings.authToken);
    for (const change of [{ authToken: "synthetic-user-b-token" }, { activeOrgId: "org-b" }, { baseUrl: "http://localhost:3006" }]) {
      await setDenBootstrapConfig({ ...settings, ...change });
      writeDenSettings({ ...settings, ...change }, { persistBootstrap: true });
      expect((await mcpAppPresentationScope(origin))?.key).not.toBe(first?.key);
      expect(first?.current()).toBe(false);
    }
  } finally { window.__OPENWORK_ELECTRON__ = desktop; }
});
test("a cached preview paints while its own fresh lease is still pending", async () => {
  await createMcpAppPresentationCache(scope, origin.workspaceId).write(launch, app);
  const pending = Promise.withResolvers<{ app: OpenworkMcpAppResource }>();
  const client = { ...origin.client, resolveMcpApp: () => pending.promise };
  const previews: OpenworkMcpAppResource[] = []; const resolutions: OpenworkMcpAppResource[] = [];
  const cancel = scheduleCachedMcpAppDiscovery({ ...origin, client }, "cloud_execute_capability", launch, false,
    value => { if (value) resolutions.push(value); }, () => { throw new Error("Unexpected failure"); }, value => previews.push(value), Promise.resolve(scope));
  for (let i = 0; i < 50 && !previews.length; i++) await new Promise(resolve => setTimeout(resolve, 1));
  expect(previews).toHaveLength(1); expect(previews[0].launchId).toBeUndefined(); expect(resolutions).toHaveLength(0);
  pending.resolve({ app: { ...app, launchId: "fresh-lease" } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(resolutions[0].launchId).toBe("fresh-lease"); cancel();
});
