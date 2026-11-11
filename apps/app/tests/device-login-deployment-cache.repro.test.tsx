/** @jsxImportSource react */
/**
 * REPRODUCTION ONLY: synthetic anonymous HTTP, not a live Den/native-app proof.
 * The desired-behaviour assertions are deliberately RED on d28ae4834e9e79456aabc151ecad2dc3b0d79b91.
 * No skip/expected-failure wrapper: setup, observer and transport failures must remain visible.
 * Real wall-clock intervals are intentional: the production hook owns the 30-second refetch.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { QueryClient as QueryClientType } from "@tanstack/react-query";
import { createDeviceLoginControl } from "../src/app/lib/device-login-control";
import { createDesktopDeviceLogin, type DeviceLoginStartOptions } from "../src/app/lib/device-login-flow";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
// Import only after DOM registration: QueryObserver must not freeze isServer=true.
const { QueryClient, QueryClientProvider, isServer } = await import("@tanstack/react-query");
const { createDenClient, readDenSettings, STORAGE_BASE_URL } = await import("../src/app/lib/den");
const { isConfiguredDenDeviceDestination } = await import("../src/app/lib/den-device-login");
const { useDeploymentFeature } = await import("../src/react-app/domains/session/status/use-desktop-feature");
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

async function settle() {
  await act(async () => { await Bun.sleep(20); });
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 2500;
  while (!check() && performance.now() < deadline) await settle();
  expect(check()).toBe(true);
}

async function mount(first: "pending" | "network" | "http-503") {
  expect(isServer).toBe(false);
  const began = performance.now();
  const waiting = deferred<Response>();
  const requests: { path: string; elapsedMs: number }[] = [];
  let featureCalls = 0;
  const fetchSpy = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    // Unknown synthetic origins use Den's same-origin /api/den proxy prefix.
    const path = new URL(String(input)).pathname.replace(/^\/api\/den(?=\/)/, "");
    requests.push({ path, elapsedMs: Math.round(performance.now() - began) });
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (path === "/v1/features") {
      featureCalls++;
      if (featureCalls === 1) {
        if (first === "pending") return waiting.promise;
        if (first === "network") throw new TypeError("Synthetic network failure");
        return Response.json({ message: "Synthetic unavailable" }, { status: 503 });
      }
      return Response.json({ features: { remoteDesktopDeviceLogin: true } });
    }
    if (path === "/api/auth/device/code") {
      return Response.json({ device_code: "synthetic-private-code", user_code: "ABCD-EFGH", expires_in: 900, interval: 60 });
    }
    throw new Error(`Unexpected synthetic request: ${path}`);
  });
  restoreFetch = () => fetchSpy.mockRestore();
  const settings = readDenSettings();
  expect(settings.baseUrl).toBe(baseUrl);
  expect(settings.authToken).toBeNull();
  const client = createDenClient({ baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl });
  let active = false;
  const flow = createDesktopDeviceLogin({
    isSignedIn: () => false,
    beginEnrollment: () => {
      active = true;
      return {
        activate: () => true,
        isCurrent: () => active,
        cancel: () => { active = false; },
      };
    },
    // Test-only enrollment boundary: real flow and anonymous Den client, no auth/settings writes.
    prepare: async () => {
      const features = await client.getDeploymentFeatures();
      return features.remoteDesktopDeviceLogin === true
        ? { baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl ?? settings.baseUrl }
        : null;
    },
    enroll: async () => { throw new Error("Enrollment is outside this reproduction"); },
  });
  cancelFlow = () => { flow.cancel(); };
  let enabled = false;
  const control = createDeviceLoginControl({ flow, deploymentEnabled: () => enabled, isConfiguredDestination: isConfiguredDenDeviceDestination });
  function Probe() {
    enabled = useDeploymentFeature("remoteDesktopDeviceLogin");
    return <output data-enabled={enabled}>{String(enabled)}</output>;
  }
  await act(async () => { root?.render(<QueryClientProvider client={queryClient}><Probe /></QueryClientProvider>); });
  const queryKey = ["den", "deployment-features", settings.baseUrl, settings.apiBaseUrl];
  const queryState = () => queryClient.getQueryState(queryKey);
  const sameDestination: DeviceLoginStartOptions = { baseUrl: settings.baseUrl, apiBaseUrl: settings.apiBaseUrl ?? undefined, force: true };
  expect(isConfiguredDenDeviceDestination({})).toBe(true);
  expect(isConfiguredDenDeviceDestination(sameDestination)).toBe(true);
  function snapshot(label: string) {
    const value = { label, elapsedMs: Math.round(performance.now() - began), featureCalls, codeCalls: requests.filter((request) => request.path === "/api/auth/device/code").length, enabled, query: queryState()?.status, fetchStatus: queryState()?.fetchStatus, control: control.status().state };
    console.log("DEVICE_CACHE_REPRO", JSON.stringify(value));
    return value;
  }
  return { control, sameDestination, requests, queryState, snapshot, began, release: () => waiting.resolve(Response.json({ features: { remoteDesktopDeviceLogin: true } })) };
}

test("REPRO: pending ON deployment must not be reported as unsupported, including explicit SAME URLs", async () => {
  const h = await mount("pending");
  expect(h.queryState()?.status).toBe("pending");
  expect(h.queryState()?.fetchStatus).toBe("fetching");
  const initial = h.snapshot("pending-at-0");
  expect(initial.enabled).toBe(false);
  expect(initial.featureCalls).toBe(1);
  expect(initial.codeCalls).toBe(0);
  const implicit = h.control.start();
  const explicitSame = h.control.start(h.sameDestination);
  const observed = await Promise.race([implicit, Bun.sleep(40).then(() => "still-waiting")]);
  console.log("DEVICE_CACHE_REPRO_PENDING_START", JSON.stringify({ implicit: observed, explicitSame: await Promise.race([explicitSame, Bun.sleep(40).then(() => "still-waiting")]) }));
  h.release();
  await until(() => host.firstElementChild?.getAttribute("data-enabled") === "true");
  expect(h.queryState()?.data).toEqual({ remoteDesktopDeviceLogin: true });
  const retry = await h.control.start();
  expect(retry).toHaveProperty("userCode", "ABCD-EFGH");
  expect(h.snapshot("pending-released-and-manually-retried").control).toBe("pending");
  // Desired regression expectation, intentionally red today (not a skipped/xfail test).
  expect(await implicit).not.toHaveProperty("state", "unsupported");
  expect(await explicitSame).not.toHaveProperty("state", "unsupported");
});

for (const failure of ["network", "http-503"] satisfies Array<"network" | "http-503">) {
  test(`REPRO: initial ${failure} must not misreport an ON deployment for the whole refetch interval`, async () => {
    const h = await mount(failure);
    await until(() => h.queryState()?.status === "error");
    await settle();
    const first = h.snapshot(`${failure}-at-0`);
    expect(first.enabled).toBe(false);
    expect(first.featureCalls).toBe(1);
    expect(first.codeCalls).toBe(0);
    const implicit = await h.control.start();
    const explicitSame = await h.control.start(h.sameDestination);
    console.log("DEVICE_CACHE_REPRO_ERROR_START", JSON.stringify({ failure, implicit, explicitSame }));
    // Do not advance Date or copy the hook interval: wait for the real QueryObserver timer.
    await act(async () => { await Bun.sleep(Math.max(0, 29_000 - (performance.now() - h.began))); });
    const before = h.snapshot(`${failure}-at-29s`);
    expect(before.featureCalls).toBe(1);
    expect(before.enabled).toBe(false);
    expect(before.query).toBe("error");
    expect(before.codeCalls).toBe(0);
    const beforeRetry = await h.control.start();
    console.log("DEVICE_CACHE_REPRO_29S_START", JSON.stringify({ failure, result: beforeRetry }));
    await act(async () => { await Bun.sleep(1400); });
    await until(() => host.firstElementChild?.getAttribute("data-enabled") === "true");
    const recovered = h.snapshot(`${failure}-after-30s-before-start`);
    expect(recovered.featureCalls).toBe(2);
    expect(recovered.query).toBe("success");
    expect(recovered.codeCalls).toBe(0);
    const retry = await h.control.start();
    expect(retry).toHaveProperty("userCode", "ABCD-EFGH");
    expect(h.snapshot(`${failure}-after-recovery-manual-start`).control).toBe("pending");
    const featureRequests = h.requests.filter((request) => request.path === "/v1/features");
    console.log("DEVICE_CACHE_REPRO_REQUEST_TIMES", JSON.stringify({ failure, requests: h.requests }));
    expect(featureRequests[1]?.elapsedMs).toBeGreaterThanOrEqual(29_900);
    // Desired regression expectations: transport trouble is not server lack of support.
    expect(implicit).not.toHaveProperty("state", "unsupported");
    expect(explicitSame).not.toHaveProperty("state", "unsupported");
    expect(beforeRetry).not.toHaveProperty("state", "unsupported");
  }, 40_000);
}
