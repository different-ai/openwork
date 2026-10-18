/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { initializeDenBootstrapConfig, setDenBootstrapConfig, writeDenSettings } from "../src/app/lib/den";
import { MODEL_PREF_KEY } from "../src/app/constants";
import { ResourceSelectionPage } from "../src/react-app/domains/cloud/org-onboarding-page";
import { CloudAccountSection } from "../src/react-app/domains/settings/cloud/cloud-account-section";
import { CloudSessionProvider } from "../src/react-app/domains/settings/cloud/cloud-session-provider";
import { BootStateProvider } from "../src/react-app/shell/boot-state";
import { PlatformProvider, createDefaultPlatform } from "../src/react-app/kernel/platform";
import { SigninDestinationSkeleton } from "../src/react-app/shell/startup-screen";
import * as features from "../src/react-app/domains/cloud/use-org-feature";
import * as desktopConfig from "../src/react-app/domains/cloud/desktop-config-provider";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  window.localStorage.clear(); window.sessionStorage.clear();
  await initializeDenBootstrapConfig();
  await setDenBootstrapConfig({ baseUrl: "https://den.example.test", apiBaseUrl: "https://den.example.test" });
  writeDenSettings({ baseUrl: "https://den.example.test", authToken: "fixture-token", activeOrgId: "org-fixture", activeOrgName: "Organization" }, { persistBootstrap: false });
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  mock.restore();
});
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});
async function mount(children: ReactNode) {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(children));
  cleanups.push(async () => { await act(async () => root.unmount()); host.remove(); });
  return host;
}

test("onboarding reports available providers but leaves model choice to chat and requests no speculative reload", async () => {
  spyOn(desktopConfig, "useDesktopConfig").mockReturnValue({ config: {}, loading: false, freshConfigStatus: "ready",
    refresh: async () => {}, refreshFresh: async () => ({}), checkRestriction: () => false, connectPolicySync: { state: "idle" } });
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  for (const [kind, data] of [
    ["providers", [{ id: "lpr_fixture", providerId: "openai", source: "custom", name: "Organization models", models: [{ id: "model-one", name: "Model one" }] }]],
    ["gateway-providers", []], ["marketplaces", []],
  ]) client.setQueryData(["den-org-onboarding", "https://den.example.test", "org-fixture", kind], data);
  const saved = JSON.stringify({ providerID: "personal-provider", modelID: "personal-model" });
  window.localStorage.setItem(MODEL_PREF_KEY, saved);
  const host = await mount(<MemoryRouter initialEntries={["/onboarding"]}><QueryClientProvider client={client}>
    <PlatformProvider value={createDefaultPlatform()}><BootStateProvider><Routes>
      <Route path="/onboarding" element={<ResourceSelectionPage />} />
      <Route path="/session" element={<div>Chat destination</div>} />
    </Routes></BootStateProvider></PlatformProvider>
  </QueryClientProvider></MemoryRouter>);
  const providers = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("AI Providers"));
  expect(providers).toBeDefined();
  await act(async () => providers?.click());
  expect(host.textContent).toMatch(/Organization models/i);
  expect(host.textContent).not.toContain("Use as default");
  const proceed = Array.from(host.querySelectorAll("button")).find(button => button.textContent?.includes("Continue to workspace"));
  expect(proceed).toBeDefined();
  await act(async () => proceed?.click());
  expect(host.textContent).toContain("Chat destination");
  expect(window.localStorage.getItem(MODEL_PREF_KEY)).toBe(saved);
  expect(window.localStorage.getItem("openwork.reloadAfterOrgOnboarding")).toBeNull();
  client.clear();
});

test("explicit organization switching remains available when remembering organizations is off or unavailable", async () => {
  const feature = spyOn(features, "useOrgFeature").mockReturnValue(false);
  const host = await mount(<MemoryRouter initialEntries={["/settings/cloud-account"]}><CloudSessionProvider><Routes>
    <Route path="/settings/cloud-account" element={<CloudAccountSection activeOrgId="org-fixture" authBusy={false}
      orgs={[{ id: "org-fixture", name: "Organization", slug: "organization", role: "member" }]}
      orgsBusy={false} orgsError={null} sessionBusy={false} onActiveOrgChange={() => {}} onOpenDashboard={() => {}}
      onRefreshOrgs={() => {}} onSignOut={() => {}} />} />
    <Route path="/onboarding" element={<div>Organization chooser</div>} />
  </Routes></CloudSessionProvider></MemoryRouter>);
  const button = Array.from(host.querySelectorAll("button")).find(button => button.textContent === "Switch organization");
  expect(button).toBeDefined();
  expect(feature).not.toHaveBeenCalled();
  await act(async () => button?.click());
  expect(host.textContent).toBe("Organization chooser");
});

test("returning-account loading has destination geometry without exposing protected content or internal sign-in steps", async () => {
  const host = await mount(<SigninDestinationSkeleton conversation />);
  expect(host.querySelector('[data-testid="signin-destination-skeleton"]')).not.toBeNull();
  expect(host.querySelector("aside")).not.toBeNull();
  expect(host.querySelector("main")).not.toBeNull();
  expect(host.textContent).not.toContain("Checking sign-in");
  expect(host.textContent).not.toContain("personal-model");
  expect(host.querySelector("button")?.textContent).toBe("Reload");
});
