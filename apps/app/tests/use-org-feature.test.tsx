/** @jsxImportSource react */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AutomationsDenContext } from "../src/react-app/domains/automations/use-automations";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { createDenClient } = await import("../src/app/lib/den");
const automations = await import("../src/react-app/domains/automations/use-automations");
const { useOrgFeature, useOrgFeatureState } = await import("../src/react-app/domains/cloud/use-org-feature");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | null = null;
let queryClient: QueryClient;
let previousBridge: unknown;
let context: AutomationsDenContext;
const orgId = "org_feature_test";

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  queryClient.setQueryData(["den", "org-features", orgId], {
    engineV2ForceUpgrade: true, automationCalendar: true, offlineRecovery: true,
  });
  const client = createDenClient({ baseUrl: "https://den.example.test", token: "test-token" });
  spyOn(client, "getOrgFeatures").mockResolvedValue({});
  context = { client, organizationId: orgId, ready: true, queryRoot: ["den", "automations", orgId] };
  spyOn(automations, "useAutomationsDenContext").mockImplementation(() => context);
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

async function renderFeatures(options: { desktopOnly?: boolean; active?: boolean } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  function Features() {
    const engine = useOrgFeature("engineV2ForceUpgrade", options);
    const calendar = useOrgFeature("automationCalendar");
    const missing = useOrgFeature("missingFeature");
    const state = useOrgFeatureState("engineV2ForceUpgrade", options);
    return <div data-engine={engine} data-calendar={calendar} data-missing={missing} data-state={state.data} />;
  }
  await act(async () => {
    root?.render(<QueryClientProvider client={queryClient}><Features /></QueryClientProvider>);
  });
  return host.firstElementChild;
}

test("desktop-only features ignore a shared true cache on a non-Electron window, without disabling web features", async () => {
  const node = await renderFeatures({ desktopOnly: true });
  expect(node?.getAttribute("data-engine")).toBe("false");
  expect(node?.getAttribute("data-state")).toBe("false");
  expect(node?.getAttribute("data-calendar")).toBe("true");
  expect(context.client?.getOrgFeatures).not.toHaveBeenCalled();
  expect(queryClient.getQueryData(["den", "org-features", orgId])).toMatchObject({ engineV2ForceUpgrade: true });
});

test("a desktop-only feature remains available from the same cache in Electron", async () => {
  Reflect.set(window, "__OPENWORK_ELECTRON__", {});
  const node = await renderFeatures({ desktopOnly: true });
  expect(node?.getAttribute("data-engine")).toBe("true");
  expect(node?.getAttribute("data-calendar")).toBe("true");
});

for (const guard of ["signed-out", "missing-client", "missing-organization"]) {
  test(`${guard} context cannot enable a feature from shared cached data`, async () => {
    if (guard === "signed-out") context = { ...context, ready: false };
    if (guard === "missing-client") context = { ...context, client: null };
    if (guard === "missing-organization") {
      context = { ...context, organizationId: null };
      queryClient.setQueryData(["den", "org-features", null], { engineV2ForceUpgrade: true, automationCalendar: true });
    }
    const node = await renderFeatures();
    expect(node?.getAttribute("data-engine")).toBe("false");
    expect(node?.getAttribute("data-calendar")).toBe("false");
    expect(node?.getAttribute("data-state")).toBe("false");
  });
}

test("inactive and missing features are false even when another observer enabled the cache", async () => {
  const node = await renderFeatures({ active: false });
  expect(node?.getAttribute("data-engine")).toBe("false");
  expect(node?.getAttribute("data-calendar")).toBe("true");
  expect(node?.getAttribute("data-missing")).toBe("false");
});

test("cache updates turn off the feature without keeping a previous true selection", async () => {
  const node = await renderFeatures();
  expect(node?.getAttribute("data-engine")).toBe("true");
  await act(async () => {
    queryClient.setQueryData(["den", "org-features", orgId], { engineV2ForceUpgrade: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(node?.getAttribute("data-engine")).toBe("false");
});
