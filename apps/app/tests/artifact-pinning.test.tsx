/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { mcpAppResourceUri } from "@openwork/types/mcp-app";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const { createDenClient } = await import("../src/app/lib/den");
const appsClient = await import("../src/react-app/domains/apps/use-apps");
const { BuiltAppPinButton } = await import("../src/react-app/domains/apps/built-app-pin-button");
const { BuiltAppCatalogSync } = await import("../src/react-app/domains/apps/built-app-catalog-sync");
const { builtDashboardScope, readBuiltDashboardApps, useBuiltDashboardApps } = await import("../src/react-app/domains/dashboard/built-dashboard-apps");
const { subscribeBuiltDashboardApps, writeBuiltDashboardApps } = await import("../src/react-app/domains/dashboard/built-dashboard-placement");
const { builtAppSummary, latestBuiltAppParts } = await import("../src/react-app/domains/apps/built-mcp-app-model");

const appId = `cob_0${"0".repeat(25)}`;
const otherId = `cob_0${"1".repeat(25)}`;
const revisionId = `cov_0${"0".repeat(25)}`;
const resourceUri = mcpAppResourceUri(appId, revisionId);
const entry = {
  connectionId: appId, serverName: "Artifacts", toolName: "open_app", projectedToolName: "open_inventory",
  resourceUri, title: "Inventory", description: null, pluginId: `plg_0${"0".repeat(25)}`, pluginName: "Inventory", requiresApproval: false,
};
let context: ReturnType<typeof appsClient.useAppsClient>;
let root: Root | null = null;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  localStorage.clear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  const client = createDenClient({ baseUrl: "https://den.example.test", token: "fixture" });
  spyOn(client, "listBuiltMcpApps").mockResolvedValue([{ ...entry, toolName: "open_app" }]);
  context = {
    identityVerified: true, canManage: false, client, orgId: "org_artifacts", orgName: "Artifacts",
    scope: ["https://den.example.test", "member_1", "org_artifacts", "https://api.example.test"],
  };
  queryClient.setQueryData(["built-dashboard-apps", ...context.scope], [entry]);
  spyOn(appsClient, "useAppsClient").mockImplementation(() => context);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  host.remove();
  queryClient.clear();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

async function render(children: ReactNode) {
  await act(async () => root?.render(<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>));
}
function Placement({ name }: { name: string }) {
  const built = useBuiltDashboardApps();
  return <output data-placement={name}>{built.ids.join(",")}</output>;
}
function placements() {
  return [...host.querySelectorAll("output")].map(node => node.textContent);
}
async function clickPin() {
  const button = host.querySelector("button");
  expect(button).not.toBeNull();
  await act(async () => button?.click());
}

test("one click pins and unpins the existing placements in all mounted views, never auto-pinning", async () => {
  await render(<><Placement name="dashboard" /><Placement name="artifacts" /><BuiltAppPinButton appId={appId} /></>);
  const key = builtDashboardScope(context.scope);
  expect(placements()).toEqual(["", ""]);
  expect(readBuiltDashboardApps(key)).toEqual([]);
  expect(host.querySelector("button")?.textContent).toBe("Pin");
  await clickPin();
  expect(placements()).toEqual([appId, appId]);
  expect(readBuiltDashboardApps(key)).toEqual([appId]);
  expect(host.querySelector("button")?.getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector("button")?.textContent).toBe("Unpin");
  await clickPin();
  expect(placements()).toEqual(["", ""]);
  expect(readBuiltDashboardApps(key)).toEqual([]);
});

test("mounted placements stay reactive when local storage cannot persist the change", async () => {
  spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("Storage unavailable"); });
  await render(<><Placement name="dashboard" /><Placement name="artifacts" /><BuiltAppPinButton appId={appId} /></>);
  await clickPin();
  expect(placements()).toEqual([appId, appId]);
  expect(host.querySelector("button")?.textContent).toBe("Unpin");
  await clickPin();
  expect(placements()).toEqual(["", ""]);
});

test("pinning is available without a rollout setting and never pins automatically", async () => {
  await render(<BuiltAppPinButton appId={appId} />);
  expect(host.querySelector("button")?.textContent).toBe("Pin");
  expect(host.querySelector("button")?.disabled).toBe(false);
  expect(readBuiltDashboardApps(builtDashboardScope(context.scope))).toEqual([]);
});

test("pinning requires verified identity and member-catalog access, not admin privileges", async () => {
  await render(<BuiltAppPinButton appId={otherId} />);
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(host.querySelector("button")?.title).toContain("isn't available");
  await clickPin();
  expect(readBuiltDashboardApps(builtDashboardScope(context.scope))).toEqual([]);
  context = { ...context, identityVerified: false };
  await render(<BuiltAppPinButton appId={appId} />);
  expect(host.querySelector("button")?.disabled).toBe(true);
  expect(host.querySelector("button")?.title).toContain("Sign in");
});

test("member, organization and server scope switches never carry placements into the new scope", async () => {
  const original = context.scope;
  const originalKey = builtDashboardScope(original);
  writeBuiltDashboardApps(originalKey, [appId]);
  const view = <><Placement name="dashboard" /><BuiltAppPinButton appId={appId} /></>;
  await render(view);
  expect(placements()).toEqual([appId]);
  for (const index of [0, 1, 2, 3]) {
    const scope = original.map((value, position) => position === index ? `${value}-other` : value);
    context = { ...context, scope };
    queryClient.setQueryData(["built-dashboard-apps", ...scope], [entry]);
    await render(<><Placement name="dashboard" /><BuiltAppPinButton appId={appId} /></>);
    expect(placements()).toEqual([""]);
    await act(async () => writeBuiltDashboardApps(originalKey, [otherId]));
    expect(placements()).toEqual([""]);
    await clickPin();
    expect(readBuiltDashboardApps(builtDashboardScope(scope))).toEqual([appId]);
  }
  expect(readBuiltDashboardApps(originalKey)).toEqual([otherId]);
});

test("storage updates and clear propagate only to matching placement subscribers", () => {
  const key = builtDashboardScope(context.scope);
  const matching = mock();
  const other = mock();
  const unsubscribe = subscribeBuiltDashboardApps(key, matching);
  const unsubscribeOther = subscribeBuiltDashboardApps(`${key}-other`, other);
  try {
    writeBuiltDashboardApps(key, [appId]);
    expect(matching).toHaveBeenLastCalledWith([appId]);
    expect(other).not.toHaveBeenCalled();
    localStorage.setItem(key, JSON.stringify([otherId, otherId, "invalid"]));
    window.dispatchEvent(new StorageEvent("storage", { key, storageArea: localStorage }));
    expect(matching).toHaveBeenLastCalledWith([otherId]);
    expect(other).not.toHaveBeenCalled();
    localStorage.clear();
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
    expect(matching).toHaveBeenLastCalledWith([]);
    expect(other).toHaveBeenLastCalledWith([]);
  } finally {
    unsubscribe();
    unsubscribeOther();
  }
});

function builderPart(toolName: string, revision = revisionId): DynamicToolUIPart {
  const uri = mcpAppResourceUri(appId, revision);
  return {
    type: "dynamic-tool", toolName, toolCallId: `${toolName}:${revision}`, state: "output-available", input: {}, output: "Ready",
    callProviderMetadata: { openwork: { mcpResult: {
      content: [{ type: "text", text: "Ready" }],
      structuredContent: { app: {
        appId, revisionId: revision, pluginId: entry.pluginId, title: "Inventory", description: null,
        textFallback: "Inventory", toolName: "open_app", resourceUri: uri, serverPath: "/mcp/app", tools: [],
      } },
      _meta: { "openwork/mcpApp": { connectionId: appId, toolName: "open_app", resourceUri: uri, arguments: {} } },
    } } },
  };
}
function messages(...parts: DynamicToolUIPart[]): UIMessage[] {
  return [{ id: "assistant", role: "assistant", parts }];
}

test("successful create and update invalidate the scoped catalog once per revision without pinning or duplicating identity", async () => {
  const invalidate = spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  const created = builderPart("create_app");
  expect(builtAppSummary(created)?.appId).toBe(appId);
  await render(<BuiltAppCatalogSync messages={messages(created)} />);
  expect(invalidate).toHaveBeenCalledTimes(1);
  expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ["built-dashboard-apps", ...context.scope], exact: true });
  await render(<BuiltAppCatalogSync messages={messages(created)} />);
  expect(invalidate).toHaveBeenCalledTimes(1);
  const updated = builderPart("update_app", `cov_0${"1".repeat(25)}`);
  await render(<BuiltAppCatalogSync messages={messages(created, updated)} />);
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(latestBuiltAppParts(messages(created, updated))).toEqual([updated]);
  expect(readBuiltDashboardApps(builtDashboardScope(context.scope))).toEqual([]);
});

test("failed and incomplete builders do not invalidate the catalog", async () => {
  const invalidate = spyOn(queryClient, "invalidateQueries").mockResolvedValue();
  const created = builderPart("create_app");
  const pending: DynamicToolUIPart = { type: "dynamic-tool", toolName: "create_app", toolCallId: "pending", state: "input-available", input: {} };
  const failed: DynamicToolUIPart = { ...pending, toolCallId: "failed", state: "output-error", errorText: "Failed" };
  const deniedResult: DynamicToolUIPart = { ...created, callProviderMetadata: { openwork: { mcpResult: { isError: true, content: [] } } } };
  await render(<BuiltAppCatalogSync messages={messages(pending, failed, deniedResult)} />);
  expect(invalidate).not.toHaveBeenCalled();
});
