import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { initializeDenBootstrapConfig, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import { createOpenworkServerClient } from "../src/app/lib/openwork-server";
import { createClientV2 } from "../src/app/lib/opencode-v2-adapter";
import { createProviderAuthStore } from "../src/react-app/domains/connections/provider-auth/store";
import { getReactQueryClient } from "../src/react-app/infra/query-client";

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  await initializeDenBootstrapConfig();
  await setDenBootstrapConfig({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test" });
  writeDenSettings({
    baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test",
    authToken: "fixture-session", activeOrgId: "org-fixture",
  }, { persistBootstrap: false });
});
afterEach(async () => {
  getReactQueryClient().clear();
  await GlobalRegistrator.unregister();
});

test("live V2 delivers Den session before skipping legacy sync and provider reads", async () => {
  const requests: string[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    requests.push(`${request.method} ${path}`);
    if (path === "/den-session") return Response.json({ ok: true });
    if (path === "/engine/status") return Response.json({
      running: true, liveProviderSync: true,
      mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
    });
    return Response.json({});
  });
  const server = createOpenworkServerClient({ baseUrl: "http://localhost:8787", hostToken: "fixture-host" });
  const client = createClientV2("http://localhost:8787/opencode2", "/workspace", {});
  const store = createProviderAuthStore({
    client: () => client,
    providers: () => [], providerDefaults: () => ({}), providerConnectedIds: () => [], disabledProviders: () => [],
    checkDesktopAppRestriction: () => false,
    selectedWorkspaceDisplay: () => ({ id: "workspace", name: "Workspace", path: "/workspace", preset: "default", workspaceType: "local" }),
    providerBaseUrl: () => "http://localhost:8787/opencode2", selectedWorkspaceRoot: () => "/workspace",
    runtimeWorkspaceId: () => "workspace",
    openworkServer: { getSnapshot: () => ({
      openworkServerStatus: "connected", openworkServerClient: server,
      openworkServerCapabilities: { providerSync: true }, openworkServerAuth: { hostToken: "fixture-host" },
    }) },
    setProviders: () => {}, setProviderDefaults: () => {}, setProviderConnectedIds: () => {}, setDisabledProviders: () => {},
    markOpencodeConfigReloadRequired: () => {},
  });
  try {
    expect(await store.runCloudProviderSync("sign_in")).toEqual({ outcome: "handled_live" });
    expect(requests.filter((request) => request.includes("/den-session") || request.includes("/engine/"))).toEqual([
      "PUT /den-session", "GET /engine/status",
    ]);
    expect(requests.some((request) => request.includes("/cloud-provider-sync/run"))).toBe(false);
    expect(requests.some((request) => request.includes("/api/model") || request.includes("/api/provider"))).toBe(false);
  } finally {
    store.dispose();
    fetch.mockRestore();
  }
});
