import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { initializeDenBootstrapConfig, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createProviderAuthStore, forgetDeliveredDenSession } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

beforeEach(async () => {
  forgetDeliveredDenSession();
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  await initializeDenBootstrapConfig();
  await setDenBootstrapConfig({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test" });
  writeDenSettings({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test", authToken: "fixture-session", activeOrgId: "org-fixture" }, { persistBootstrap: false });
});
afterEach(async () => {
  getReactQueryClient().clear();
  await GlobalRegistrator.unregister();
});

for (const mode of ["ready", "inventory_unavailable", "stale_sync", "refresh_failed"]) test(`Share joins the actual Gateway and engine catalog (${mode})`, async () => {
  const requests: string[] = [];
  let featureEnabled = true;
  let refreshed = false;
  let statusReads = 0;
  let release = () => {};
  let entered = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path.endsWith("/share")) return Response.json({ inferenceProviderId: "ipr_fixture", name: "Shared provider" });
    if (path.endsWith("/engine-v2-preview/status")) {
      statusReads += 1;
      if (mode === "stale_sync" && statusReads === 1) { entered(); await held; }
      return Response.json({ enabled: true, running: true, chatRouting: true, liveProviderSync: true, mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [] });
    }
    if (path.endsWith("/gateway/refresh")) {
      if (mode === "refresh_failed") return new Response("Unavailable", { status: 503 });
      refreshed = true;
      return Response.json({ ok: true });
    }
    if (path.endsWith("/v1/inference-providers")) return mode === "inventory_unavailable"
      ? new Response("Unavailable", { status: 503 })
      : Response.json({ inferenceProviders: [{ id: "ipr_fixture", providerId: "openai", name: "Shared provider", source: "openwork_gateway", credentialStatus: "ready", models: [{ id: "gwm_01aaaaaaaaaaaaaaaaaaaaaaaa_01bbbbbbbbbbbbbbbbbbbbbbbb_01cccccccccccccccccccccccc", name: "Shared model", config: { id: "gwm_01aaaaaaaaaaaaaaaaaaaaaaaa_01bbbbbbbbbbbbbbbbbbbbbbbb_01cccccccccccccccccccccccc" }, upstreamModelId: "model", modelGroupId: "gmg_01aaaaaaaaaaaaaaaaaaaaaaaa", modelGroupName: "Models", credentialSetId: "gcs_01bbbbbbbbbbbbbbbbbbbbbbbb", credentialSetName: "Credentials" }] }] });
    if (path.endsWith("/api/model")) return Response.json(refreshed ? [{ id: "gwm_01aaaaaaaaaaaaaaaaaaaaaaaa_01bbbbbbbbbbbbbbbbbbbbbbbb_01cccccccccccccccccccccccc", providerID: "ipr_fixture" }] : []);
    if (path.endsWith("/api/provider")) return Response.json([{ id: "ipr_fixture", name: "Shared provider" }]);
    if (path === "/v1/llm-providers") return Response.json({ providers: [] });
    return Response.json({ ok: true });
  });
  const server = createOpenworkServerClient({ baseUrl: "http://localhost:8787", hostToken: "fixture-host" });
  const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
  const store = createProviderAuthStore({
    providerFilterSyncFixEnabled: () => featureEnabled,
    client: () => client, providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
    providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace", runtimeWorkspaceId: () => "workspace",
    openworkServer: { getSnapshot: () => ({ openworkServerStatus: "connected", openworkServerClient: server, openworkServerCapabilities: { providerSync: true }, openworkServerAuth: { hostToken: "fixture-host" } }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {}, markOpencodeConfigReloadRequired: () => {},
  });
  try {
    const shared = await store.shareDeviceProvider("openai");
    expect(shared).toMatchObject({ inferenceProviderId: "ipr_fixture" });
    const previousSync = mode === "stale_sync" ? store.runCloudProviderSync("manual") : null;
    if (previousSync) await started;
    const arrival = store.syncSharedDeviceProvider("openai", shared);
    release();
    await previousSync;
    if (mode === "inventory_unavailable" || mode === "refresh_failed") await expect(arrival).resolves.toEqual({ status: "pending" });
    else {
      await expect(arrival).resolves.toEqual({ status: "arrived", organizationProviderId: "ipr_fixture", name: "Shared provider" });
      expect(requests.some((request) => request.endsWith("/api/model"))).toBe(true);
      expect(store.getSnapshot().liveGatewayProviders?.map((provider) => provider.id)).toEqual(["ipr_fixture"]);
    }
    expect(requests.filter((request) => request.endsWith("/gateway/refresh"))).toHaveLength(1);
    expect(requests.some((request) => request.endsWith("/cloud-provider-sync/run"))).toBe(false);
    if (mode === "stale_sync") expect(statusReads).toBe(2);
    if (mode === "ready") await expect(store.syncSharedDeviceProvider("openai", shared)).resolves.toMatchObject({ status: "arrived" });
    expect(requests.filter((request) => request.endsWith("/share"))).toHaveLength(1);
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
    featureEnabled = false;
    const beforeDisabledCheck = requests.length;
    await expect(store.syncSharedDeviceProvider("openai", shared)).resolves.toEqual({ status: "pending" });
    expect(requests).toHaveLength(beforeDisabledCheck);
  } finally {
    store.dispose();
    fetch.mockRestore();
  }
});
