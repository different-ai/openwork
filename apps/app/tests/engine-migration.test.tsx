/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import type { EngineV2PreviewStatus } from "../src/app/lib/openwork-server";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createDenClient } = await import("../src/app/lib/den");
const server = await import("../src/app/lib/openwork-server");
const automations = await import("../src/react-app/domains/automations/use-automations");
const connection = await import("../src/react-app/shell/openwork-connection");
const { EngineMigrationOverlay } = await import("../src/react-app/shell/engine-migration");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let queryClient: QueryClient;
let previousBridge: unknown;
const status: EngineV2PreviewStatus = {
  enabled: false, running: false, chatRouting: false, v1HistoryAvailable: true,
  mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [],
  migration: { state: "idle", imported: 0, skipped: 0, total: 2 },
};

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(["den", "org-features", "org_test"], { engineV2ForceUpgrade: true });
  spyOn(automations, "useAutomationsDenContext").mockReturnValue({
    client: createDenClient({ baseUrl: "https://den.example.test", token: "test-token" }),
    organizationId: "org_test", ready: true, queryRoot: ["den", "automations", "org_test"],
  });
  spyOn(connection, "resolveOpenworkConnection").mockResolvedValue({
    normalizedBaseUrl: "http://localhost:8787", resolvedToken: "test-token", resolvedHostToken: "test-host",
    hostInfo: null, source: "stored-settings",
  });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  queryClient.clear();
  Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
  document.body.innerHTML = "";
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});
function engineClient() {
  const client = server.createOpenworkServerClient({ baseUrl: "http://localhost:8787", token: "test-token" });
  spyOn(client, "getEngineV2PreviewStatus").mockResolvedValue(status);
  spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue(status);
  spyOn(server, "createOpenworkServerClient").mockReturnValue(client);
  return client;
}
async function renderOverlay() {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}><EngineMigrationOverlay /></QueryClientProvider>);
  });
}
async function setPolicy(upgrade: boolean) {
  await act(async () => {
    queryClient.setQueryData(["den", "org-features", "org_test"], { engineV2ForceUpgrade: upgrade });
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

for (const desktop of [false, true]) {
  test(`retired invitation, consent and switch controls are absent (${desktop ? "desktop" : "web"})`, async () => {
    if (desktop) Reflect.set(window, "__OPENWORK_ELECTRON__", {});
    const client = engineClient();
    await renderOverlay();
    expect(document.body.textContent).toBe("");
    expect(document.querySelector("button, [role=dialog], [role=alertdialog]")).toBeNull();
    expect(client).not.toHaveProperty("migrateOpencodeHistory");
  });
}

test("palette and Advanced settings no longer register legacy engine actions", () => {
  const palette = readFileSync(new URL("../src/react-app/shell/command-palette.tsx", import.meta.url), "utf8");
  const advanced = readFileSync(new URL("../src/react-app/domains/settings/pages/advanced-view-sections.tsx", import.meta.url), "utf8");
  expect(palette).not.toMatch(/useOpencodeEngineControls|opencode\.switch-v1|opencode\.migrate-v2/);
  expect(advanced).not.toMatch(/AdvancedEngineV2PreviewSection|data-engine="v1"|Migrate chats to OpenCode v2/);
  const sections = readFileSync(new URL("../src/react-app/domains/settings/advanced-sections.ts", import.meta.url), "utf8");
  expect(sections).not.toContain("experimental-engine");
});

test("web never resolves a local engine or forwards cached desktop policy", async () => {
  const client = engineClient();
  await renderOverlay();
  expect(connection.resolveOpenworkConnection).not.toHaveBeenCalled();
  expect(client.setEngineV2ForcePolicy).not.toHaveBeenCalled();
});

test("desktop preserves host-owned force policy including off transitions", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  await renderOverlay();
  expect(client.setEngineV2ForcePolicy).toHaveBeenLastCalledWith({ upgrade: true });
  await setPolicy(false);
  expect(client.setEngineV2ForcePolicy).toHaveBeenLastCalledWith({ upgrade: false });
  expect(client).not.toHaveProperty("migrateOpencodeHistory");
});

test("a failed policy write cannot fall back to a renderer-owned migration", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(client, "setEngineV2ForcePolicy").mockRejectedValue(new Error("Host unavailable"));
  await renderOverlay();
  expect(client.setEngineV2ForcePolicy).toHaveBeenCalledTimes(1);
  expect(client).not.toHaveProperty("migrateOpencodeHistory");
  expect(document.body.textContent).toBe("");
});

test("newer off waits for in-flight on and ignores its stale routing", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  const pending = Promise.withResolvers<EngineV2PreviewStatus>();
  const policy = spyOn(client, "setEngineV2ForcePolicy").mockImplementationOnce(() => pending.promise).mockResolvedValue(status);
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    await renderOverlay();
    await setPolicy(false);
    expect(policy).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ...status, enabled: true, chatRouting: true, engineForced: true }));
    expect(policy).toHaveBeenLastCalledWith({ upgrade: false });
    expect(changed).not.toHaveBeenCalled();
  } finally { window.removeEventListener("openwork-engine-changed", changed); }
});

test("adopted host status refreshes routing without invitation or consent", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const client = engineClient();
  spyOn(client, "setEngineV2ForcePolicy").mockResolvedValue({ ...status, enabled: true, chatRouting: true, engineForced: true });
  const changed = mock(() => {});
  window.addEventListener("openwork-engine-changed", changed);
  try {
    await renderOverlay();
    expect(changed).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toBe("");
    expect(client).not.toHaveProperty("migrateOpencodeHistory");
  } finally { window.removeEventListener("openwork-engine-changed", changed); }
});
