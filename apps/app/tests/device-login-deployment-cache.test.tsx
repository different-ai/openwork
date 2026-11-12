/** @jsxImportSource react */
/** Synthetic anonymous HTTP regression coverage, not a live Den/native-app proof. */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import { createDeviceLoginControl } from "../src/app/lib/device-login-control";
import { createDesktopDeviceLogin, type DeviceLoginStartOptions } from "../src/app/lib/device-login-flow";
import type { DeploymentFeatureSnapshot } from "../src/react-app/domains/session/status/use-deployment-feature";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Import after DOM registration: QueryObserver must not freeze isServer=true.
const { QueryClient, QueryClientProvider, isServer } = await import("@tanstack/react-query");
const { readDenSettings, resolveDenBaseUrls, STORAGE_BASE_URL } = await import("../src/app/lib/den");
const { isConfiguredDenDeviceDestination, readDeviceLoginDeployment } = await import("../src/app/lib/den-device-login");
const { useDeploymentFeature } = await import("../src/react-app/domains/session/status/use-deployment-feature");
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root | null = null;
let host: HTMLDivElement;
let queryClient: QueryClientType;
let restoreFetch = () => {};
let cancelFlow = () => {};
let previousBridge: unknown;
let stored: [string, string][];
const baseUrl = "https://device-cache.example.test";

beforeEach(() => {
  previousBridge = window.__OPENWORK_ELECTRON__;
  Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  stored = Object.entries(window.localStorage);
  window.localStorage.clear();
  window.localStorage.setItem(STORAGE_BASE_URL, baseUrl);
  queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  cancelFlow();
  cancelFlow = () => {};
  if (root) await act(async () => root?.unmount());
  root = null;
  queryClient.clear();
  restoreFetch();
  restoreFetch = () => {};
  host.remove();
  window.localStorage.clear();
  for (const [key, value] of stored) window.localStorage.setItem(key, value);
  if (previousBridge === undefined) Reflect.deleteProperty(window, "__OPENWORK_ELECTRON__");
  else Reflect.set(window, "__OPENWORK_ELECTRON__", previousBridge);
});

afterAll(async () => {
  if (previousAct === undefined) Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  else Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  if (ownedDom) await GlobalRegistrator.unregister();
});

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function settle() { await act(async () => { await Bun.sleep(20); }); }
async function until(check: () => boolean) {
  const deadline = performance.now() + 2500;
  while (!check() && performance.now() < deadline) await settle();
  expect(check()).toBe(true);
}

async function mount(first: "pending" | "network" | "http-503" | "off") {
  expect(isServer).toBe(false);
  const began = performance.now();
  const waiting = deferred<Response>();
  const requests: { path: string; elapsedMs: number }[] = [];
  let featureCalls = 0;
  let failDiscovery = false;
  let liveEnabled = true;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/den(?=\/)/, "");
    requests.push({ path, elapsedMs: Math.round(performance.now() - began) });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (path === "/v1/features") {
      featureCalls++;
      if (failDiscovery) throw new TypeError("Synthetic unavailable");
      if (featureCalls === 1 && first === "pending") return waiting.promise;
      // First failure belongs to the hook, the second to live flow discovery.
      if (featureCalls <= 2 && first === "network") throw new TypeError("Synthetic network failure");
      if (featureCalls <= 2 && first === "http-503") return Response.json({ message: "Synthetic unavailable" }, { status: 503 });
      return Response.json({ features: { remoteDesktopDeviceLogin: featureCalls === 1 && first === "off" ? false : liveEnabled } });
    }
    if (path === "/api/auth/device/code") return Response.json({ device_code: "synthetic-private-code", user_code: "ABCD-EFGH", expires_in: 900, interval: 60 });
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
  restoreFetch = () => fetchSpy.mockRestore();
  const settings = readDenSettings();
  expect(settings.baseUrl).toBe(baseUrl);
  expect(settings.authToken).toBeNull();
  const destination = resolveDenBaseUrls(settings);
  let active = false;
  const flow = createDesktopDeviceLogin({
    isSignedIn: () => false,
    beginEnrollment: () => {
      active = true;
      return { activate: () => true, isCurrent: () => active, cancel: () => { active = false; } };
    },
    // Real flow/discovery transport with a test-only enrollment boundary.
    prepare: async (_options, signal) => await readDeviceLoginDeployment(destination.apiBaseUrl, signal) ? destination : null,
    enroll: async () => { throw new Error("Enrollment is outside this regression"); },
  });
  cancelFlow = () => { flow.cancel(); };
  let feature: DeploymentFeatureSnapshot = { enabled: undefined, updatedAt: 0 };
  const control = createDeviceLoginControl({ flow, deploymentFeature: () => feature, isConfiguredDestination: isConfiguredDenDeviceDestination });
  function Probe() {
    feature = useDeploymentFeature("remoteDesktopDeviceLogin");
    return <output data-enabled={String(feature.enabled)}>{String(feature.enabled)}</output>;
  }
  await act(async () => { root?.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
  const queryKey = ["den", "deployment-features", settings.baseUrl, settings.apiBaseUrl];
  const queryState = () => queryClient.getQueryState(queryKey);
  const sameDestination: DeviceLoginStartOptions = { baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl ?? undefined, force: true };
  expect(isConfiguredDenDeviceDestination({})).toBe(true);
  expect(isConfiguredDenDeviceDestination(sameDestination)).toBe(true);
  function snapshot(label: string) {
    const value = { label, elapsedMs: Math.round(performance.now() - began), featureCalls, codeCalls: requests.filter((request) => request.path === "/api/auth/device/code").length, enabled: feature.enabled, query: queryState()?.status, fetchStatus: queryState()?.fetchStatus, control: control.status().state };
    console.log("DEVICE_CACHE_REGRESSION", JSON.stringify(value));
    return value;
  }
  return {
    control, sameDestination, requests, queryState, snapshot,
    feature: () => feature,
    fail: () => { failDiscovery = true; },
    off: () => { liveEnabled = false; },
    refresh: () => queryClient.invalidateQueries({ queryKey }),
    release: () => waiting.resolve(Response.json({ features: { remoteDesktopDeviceLogin: true } })),
  };
}

test("pending ON discovery is unknown, not unsupported, including explicit SAME URLs", async () => {
  const h = await mount("pending");
  expect(h.queryState()?.status).toBe("pending");
  expect(h.queryState()?.fetchStatus).toBe("fetching");
  expect(h.snapshot("pending-at-0")).toMatchObject({ enabled: undefined, featureCalls: 1, codeCalls: 0, control: "failed" });
  expect(await h.control.start()).toHaveProperty("userCode", "ABCD-EFGH");
  expect(h.snapshot("pending-hook-live-start")).toMatchObject({ enabled: undefined, featureCalls: 2, codeCalls: 1, control: "pending" });
  expect(await h.control.start(h.sameDestination)).toHaveProperty("userCode", "ABCD-EFGH");
  expect(h.control.status().state).toBe("pending");
  h.release();
  await until(() => h.feature().enabled === true);
  expect(h.queryState()?.data).toEqual({ remoteDesktopDeviceLogin: true });
  expect(h.snapshot("pending-recovered")).toMatchObject({ featureCalls: 3, codeCalls: 2, control: "pending" });
});

for (const failure of ["network", "http-503"] satisfies Array<"network" | "http-503">) {
  test(`initial ${failure} and one live-read failure recover without waiting for the hook refetch interval`, async () => {
    const h = await mount(failure);
    await until(() => h.queryState()?.status === "error");
    await settle();
    expect(h.snapshot(`${failure}-at-0`)).toMatchObject({ enabled: undefined, featureCalls: 1, codeCalls: 0, control: "failed" });
    expect(await h.control.start()).toHaveProperty("userCode", "ABCD-EFGH");
    expect(h.snapshot(`${failure}-live-retry`)).toMatchObject({ enabled: undefined, featureCalls: 3, codeCalls: 1, query: "error", control: "pending" });
    expect(await h.control.start(h.sameDestination)).toHaveProperty("userCode", "ABCD-EFGH");
    const recovered = h.snapshot(`${failure}-same-destination`);
    expect(recovered).toMatchObject({ enabled: undefined, featureCalls: 4, codeCalls: 2, query: "error", control: "pending" });
    expect(recovered.elapsedMs).toBeLessThan(2500);
  });
}

test("stale cached OFF cannot kill live ON admission; a fresh OFF still kills pending work", async () => {
  const h = await mount("off");
  await until(() => h.feature().enabled === false);
  expect(await h.control.start()).toHaveProperty("userCode");
  expect(h.control.status().state).toBe("pending");
  // Ensure the later observation has a distinct wall-clock timestamp.
  await settle();
  const oldUpdatedAt = h.feature().updatedAt;
  h.off();
  await act(async () => { await h.refresh(); });
  await until(() => h.feature().updatedAt > oldUpdatedAt && h.feature().enabled === false);
  expect(h.control.status().state).toBe("unsupported");
  expect(h.requests.filter((request) => request.path === "/api/auth/device/code")).toHaveLength(1);
});

for (const cached of [true, false]) {
  test(`failed refetch with stale ${cached ? "ON" : "OFF"} becomes unknown and does not cancel`, async () => {
    const h = await mount(cached ? "pending" : "off");
    if (cached) { h.release(); await until(() => h.feature().enabled === true); }
    else await until(() => h.feature().enabled === false);
    expect(await h.control.start()).toHaveProperty("userCode");
    h.fail();
    await act(async () => { await h.refresh(); });
    await until(() => h.queryState()?.status === "error" && h.feature().enabled === undefined);
    expect(h.queryState()?.data).toEqual({ remoteDesktopDeviceLogin: cached });
    expect(h.control.status().state).toBe("pending");
  });
}
