/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { DenOrgLlmProvider, DenOrgMarketplace } from "../src/app/lib/den";
import type { GatewayProviderSummary } from "@openwork/types/den/gateway";

GlobalRegistrator.register({ url: "http://localhost/" });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

mock.module("../src/react-app/domains/cloud/desktop-config-provider", () => ({
  useDesktopConfig: () => ({ refreshFresh: async () => ({ aiGateway: false, gatewayDashboard: false }) }),
}));
mock.module("../src/components/dither-backdrop", () => ({ DitherBackdrop: () => null }));

const { createRoot } = await import("react-dom/client");
const { ResourceSelectionPage } = await import("../src/react-app/domains/cloud/org-onboarding-page");
const { PlatformProvider, createDefaultPlatform } = await import("../src/react-app/kernel/platform");
const { BootStateProvider } = await import("../src/react-app/shell/boot-state");
const { writeDenSettings } = await import("../src/app/lib/den");
const { readStoredDefaultModel } = await import("../src/react-app/kernel/model-config");

const originalFetch = globalThis.fetch;
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let queryClient: QueryClient;
let providers: DenOrgLlmProvider[];
let gatewayProviders: GatewayProviderSummary[];
let marketplaces: DenOrgMarketplace[];
let gatewayResponse: () => Promise<Response>;
let requests: string[];

function legacyProvider(source: DenOrgLlmProvider["source"] = "openwork", modelCount = 0): DenOrgLlmProvider {
  return {
    id: `lpr_${source}`,
    source,
    providerId: source === "openwork" ? "openwork" : "openai",
    name: source === "openwork" ? "Managed workspace models" : "Legacy team AI",
    providerConfig: {},
    hasApiKey: true,
    models: Array.from({ length: modelCount }, (_, index) => ({
      id: `model-${index}`, name: `Model ${index}`, config: {}, createdAt: null,
    })),
    createdAt: null,
    updatedAt: null,
  };
}

function gatewayProvider(id = "ipr_test", credentialStatus: GatewayProviderSummary["credentialStatus"] = "ready"): GatewayProviderSummary {
  return {
    id,
    source: "openwork_gateway",
    providerId: "openai",
    name: `Gateway ${id}`,
    credentialMode: "per_member",
    credentialStatus,
    status: "active",
    updatedAt: "2026-09-01T00:00:00.000Z",
    providerConfig: {},
    modelIds: [],
    models: [],
    authUrl: null,
    authorizationRequests: [],
  };
}

async function settle(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    if (check()) return;
  }
  throw new Error(`UI did not settle: ${host.textContent}`);
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(label));
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

async function mount(autoContinue = false) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PlatformProvider value={createDefaultPlatform()}>
          <BootStateProvider>
            <MemoryRouter initialEntries={["/onboarding"]}>
              <Routes>
                <Route path="/onboarding" element={<ResourceSelectionPage autoContinue={autoContinue} />} />
                <Route path="/session" element={<div>Workspace destination</div>} />
              </Routes>
            </MemoryRouter>
          </BootStateProvider>
        </PlatformProvider>
      </QueryClientProvider>,
    );
  });
}

async function showResources() {
  await mount();
  await settle(() => !host.textContent?.includes("Loading available resources"));
}

async function expand(label: string) {
  await act(async () => { button(label).click(); });
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  writeDenSettings({
    baseUrl: "https://den.example.test",
    authToken: "test-token",
    activeOrgId: "org_test",
    activeOrgName: "Test workspace",
  });
  providers = [];
  gatewayProviders = [];
  marketplaces = [];
  requests = [];
  gatewayResponse = async () => Response.json({ inferenceProviders: gatewayProviders });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/api\/den/, "");
      requests.push(`${path}${url.search}`);
      if (path === "/v1/llm-providers") return Response.json({ llmProviders: providers });
      if (path === "/v1/inference-providers") return gatewayResponse();
      if (path === "/v1/marketplaces") return Response.json({ items: marketplaces });
      throw new Error(`Unexpected request: ${url.pathname}`);
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  queryClient.clear();
  host.remove();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});

describe("organization resource overview", () => {
  test("shows accessible OpenWork Models without card or aggregate model counts", async () => {
    providers = [legacyProvider()];
    await showResources();
    await expand("OpenWork Models");
    expect(host.textContent).toContain("Managed workspace models");
    expect(host.textContent).not.toMatch(/\d+ models?/i);
    expect(host.textContent).not.toContain("AI Gateway");
    expect(host.querySelectorAll('[data-slot="accordion-item"]')).toHaveLength(1);
    expect(host.textContent).not.toContain("Use as default");
  });

  test("counts Gateway-only access as providers, lists names, and finishes with reload and seen IDs", async () => {
    gatewayProviders = [gatewayProvider("ipr_first"), gatewayProvider("ipr_second")];
    window.localStorage.setItem("openwork.seenProviderIds", JSON.stringify(["lpr_existing"]));
    await showResources();
    expect(button("AI Gateway").textContent).toContain("2 AI providers");
    expect(host.textContent).not.toContain("No resources");
    await expand("AI Gateway");
    expect(host.textContent).toContain("Gateway ipr_first");
    expect(host.textContent).toContain("Gateway ipr_second");
    expect(host.textContent).not.toMatch(/\d+ models?/i);
    expect(host.textContent).not.toContain("Use as default");
    await act(async () => { button("Continue to workspace").click(); });
    expect(host.textContent).toContain("Workspace destination");
    expect(window.localStorage.getItem("openwork.reloadAfterOrgOnboarding")).toBe("1");
    expect(JSON.parse(window.localStorage.getItem("openwork.seenProviderIds") ?? "[]")).toEqual([
      "lpr_existing", "ipr_first", "ipr_second",
    ]);
    expect(requests).toContain("/v1/inference-providers?scope=usable");
    expect(requests.some((path) => path.includes("/connect"))).toBe(false);
  });

  test("entirely hides Gateway when the accessible list is empty", async () => {
    await showResources();
    expect(host.textContent).not.toContain("AI Gateway");
    expect(host.textContent).not.toContain("0 AI providers");
    expect(host.textContent).toContain("No resources have been configured");
    expect(host.querySelector('[data-slot="accordion-item"]')).toBeNull();
  });

  test("preserves legacy model counts and marketplaces but excludes OpenWork models from every count", async () => {
    providers = [legacyProvider("openwork", 7), legacyProvider("custom", 2)];
    marketplaces = [{ id: "mkt_test", name: "Team tools", description: "Shared tools", pluginCount: 3, status: "active", updatedAt: null }];
    await showResources();
    expect(button("AI Providers").textContent).toContain("2 models");
    expect(button("OpenWork Models").textContent).not.toMatch(/\d/);
    expect(button("Collections").textContent).toContain("1 marketplace");
    await expand("OpenWork Models");
    await expand("AI Providers");
    await expand("Collections");
    expect(host.textContent).not.toContain("7 models");
    expect(host.textContent).not.toContain("9 models");
    expect(host.textContent).not.toContain("+2 more");
    expect(host.textContent).toContain("Legacy Team AI");
    expect(host.textContent).toContain("Team tools");
    expect(host.textContent).toContain("3 plugins");
    expect(Array.from(host.querySelectorAll("button")).filter((node) => node.textContent === "Use as default")).toHaveLength(1);
    await act(async () => { button("Use as default").click(); });
    expect(host.textContent).toContain("will be set as your default model");
  });

  for (const status of ["member_auth_required", "org_credential_missing"] satisfies GatewayProviderSummary["credentialStatus"][]) {
    test(`counts accessible Gateway providers with ${status} and no ready models`, async () => {
      gatewayProviders = [gatewayProvider("ipr_pending", status)];
      await showResources();
      expect(button("AI Gateway").textContent).toContain("1 AI provider");
      await expand("AI Gateway");
      expect(host.textContent).toContain("Gateway ipr_pending");
      expect(host.textContent).not.toMatch(/\d+ models?|connected/i);
      expect(host.textContent).not.toContain("Use as default");
    });
  }

  test("waits for Gateway before enabling continue", async () => {
    let resolveGateway: (response: Response) => void = () => { throw new Error("Gateway request not started"); };
    gatewayResponse = () => new Promise<Response>((resolve) => { resolveGateway = resolve; });
    await mount();
    await settle(() => requests.includes("/v1/inference-providers?scope=usable"));
    expect(host.textContent).toContain("Loading available resources");
    expect(button("Continue").disabled).toBe(true);
    await act(async () => { resolveGateway(Response.json({ inferenceProviders: [gatewayProvider()] })); });
    await settle(() => host.textContent?.includes("AI Gateway") === true);
    expect(button("Continue to workspace").disabled).toBe(false);
  });

  test("auto-continue waits for Gateway and marks accessible providers seen without forcing a reload", async () => {
    let resolveGateway: (response: Response) => void = () => { throw new Error("Gateway request not started"); };
    gatewayResponse = () => new Promise<Response>((resolve) => { resolveGateway = resolve; });
    await mount(true);
    await settle(() => requests.includes("/v1/inference-providers?scope=usable"));
    expect(host.textContent).not.toContain("Workspace destination");
    await act(async () => { resolveGateway(Response.json({ inferenceProviders: [gatewayProvider()] })); });
    await settle(() => host.textContent?.includes("Workspace destination") === true);
    expect(JSON.parse(window.localStorage.getItem("openwork.seenProviderIds") ?? "[]")).toEqual(["ipr_test"]);
    expect(window.localStorage.getItem("openwork.reloadAfterOrgOnboarding")).toBeNull();
  });

  test("preserves legacy resources when Gateway is unavailable on an older server", async () => {
    providers = [legacyProvider("models_dev", 1)];
    gatewayResponse = async () => new Response("Not supported", { status: 404 });
    await showResources();
    expect(button("AI Providers").textContent).toContain("1 model");
    expect(host.textContent).not.toContain("AI Gateway");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await expand("AI Providers");
    await act(async () => { button("Use as default").click(); });
    await act(async () => { button("Continue to workspace").click(); });
    expect(host.textContent).toContain("Workspace destination");
    expect(readStoredDefaultModel()).toEqual({ providerID: "lpr_models_dev", modelID: "model-0" });
    expect(JSON.parse(window.localStorage.getItem("openwork.seenProviderIds") ?? "[]")).toEqual(["lpr_models_dev"]);
    expect(window.localStorage.getItem("openwork.reloadAfterOrgOnboarding")).toBe("1");
  });

  test("keeps loaded legacy resources visible alongside a Gateway access error", async () => {
    providers = [legacyProvider("custom", 1)];
    gatewayResponse = async () => Response.json({ error: "forbidden", message: "Gateway access denied" }, { status: 403 });
    await showResources();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Gateway access denied");
    expect(button("AI Providers").textContent).toContain("1 model");
    expect(host.textContent).not.toContain("AI Gateway");
  });

  test("surfaces Gateway failures instead of an empty overview or automatic continuation", async () => {
    gatewayResponse = async () => Response.json({ error: "gateway_failed", message: "Gateway access could not be loaded" }, { status: 503 });
    await mount(true);
    await settle(() => host.textContent?.includes("Gateway access could not be loaded") === true);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Gateway access could not be loaded");
    expect(host.textContent).not.toContain("No resources have been configured");
    expect(host.textContent).not.toContain("Workspace destination");
  });
});
