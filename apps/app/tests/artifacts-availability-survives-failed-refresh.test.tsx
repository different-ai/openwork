/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

const ownsDom = !GlobalRegistrator.isRegistered;
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

// A signed-in member of one organization. The provider and the Artifacts gate
// stay real; only the sign-in state and the Den request are replaced.
const cacheKey = "openwork.den.desktopConfig:https://den.test::org_1";
let activeOrgId = "org_1";
let nextDesktopConfig: () => Promise<Record<string, unknown>> = async () => ({});
const denAuth = await import("../src/react-app/domains/cloud/den-auth-provider");
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  ...denAuth,
  useDenAuth: () => ({ status: "signed_in", isSignedIn: true, user: { id: "user_1" }, verifiedIdentity: null, error: null, refresh: async () => {} }),
}));
const den = await import("../src/app/lib/den");
mock.module("../src/app/lib/den", () => ({
  ...den,
  readDenSettings: () => ({ baseUrl: "https://den.test", apiBaseUrl: "https://den.test", authToken: "token", activeOrgId }),
  getDenDesktopConfigCacheKey: () => cacheKey.replace("org_1", activeOrgId),
  createDenClient: () => ({ getDesktopConfig: () => nextDesktopConfig() }),
}));

const { DesktopConfigProvider } = await import("../src/react-app/domains/cloud/desktop-config-provider");
const { useDashboardDeploymentAvailability } = await import("../src/react-app/domains/dashboard/dashboard-availability");
const { denSettingsChangedEvent } = await import("../src/app/lib/den-session-events");

let root: ReturnType<typeof createRoot> | null = null;
let artifacts = { enabled: false, loading: true };

function ArtifactsGate() {
  artifacts = useDashboardDeploymentAvailability();
  return null;
}

async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function refreshOnReturnToApp(result: () => Promise<Record<string, unknown>>) {
  nextDesktopConfig = result;
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  await settle();
}

beforeEach(async () => {
  window.localStorage.clear();
  activeOrgId = "org_1";
  artifacts = { enabled: false, loading: true };
  nextDesktopConfig = async () => ({ dashboardEnabled: true });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root?.render(<DesktopConfigProvider><ArtifactsGate /></DesktopConfigProvider>); });
  await settle();
});

afterEach(async () => {
  await act(async () => { root?.unmount(); });
  root = null;
  document.body.replaceChildren();
});

afterAll(async () => {
  mock.restore();
  if (ownsDom) await GlobalRegistrator.unregister();
});

test("Artifacts stays available when a later background refresh cannot reach Den", async () => {
  expect(artifacts).toEqual({ enabled: true, loading: false });

  await refreshOnReturnToApp(async () => { throw new TypeError("Failed to fetch"); });
  expect(artifacts).toEqual({ enabled: true, loading: false });

  await refreshOnReturnToApp(async () => { throw new den.DenApiError(503, "request_failed", "Request failed with 503."); });
  expect(artifacts).toEqual({ enabled: true, loading: false });
});

test("Artifacts stays available while an unchanged sign-in is read again", async () => {
  let release: (config: Record<string, unknown>) => void = () => {};
  nextDesktopConfig = () => new Promise((resolve) => { release = resolve; });
  await act(async () => { window.dispatchEvent(new CustomEvent(denSettingsChangedEvent)); });
  expect(artifacts).toEqual({ enabled: true, loading: false });

  await act(async () => { release({ dashboardEnabled: true }); });
  await settle();
  expect(artifacts).toEqual({ enabled: true, loading: false });
});

test("Artifacts goes away when Den answers that it is off or refuses the member", async () => {
  await refreshOnReturnToApp(async () => ({ dashboardEnabled: false }));
  expect(artifacts.enabled).toBe(false);

  await refreshOnReturnToApp(async () => ({ dashboardEnabled: true }));
  expect(artifacts.enabled).toBe(true);

  await refreshOnReturnToApp(async () => { throw new den.DenApiError(403, "forbidden", "You do not have access to this organization."); });
  expect(artifacts.enabled).toBe(false);
});

test("another organization waits for its own answer", async () => {
  let release: (config: Record<string, unknown>) => void = () => {};
  nextDesktopConfig = () => new Promise((resolve) => { release = resolve; });
  activeOrgId = "org_2";
  await act(async () => { window.dispatchEvent(new CustomEvent(denSettingsChangedEvent)); });
  expect(artifacts).toEqual({ enabled: false, loading: true });

  await act(async () => { release({ dashboardEnabled: true }); });
  await settle();
  expect(artifacts).toEqual({ enabled: true, loading: false });
});

test("a start that cannot reach Den keeps Artifacts hidden, as before", async () => {
  await act(async () => { root?.unmount(); });
  nextDesktopConfig = async () => { throw new TypeError("Failed to fetch"); };
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => { root?.render(<DesktopConfigProvider><ArtifactsGate /></DesktopConfigProvider>); });
  await settle();
  // The cached config from the earlier sign-in says Artifacts is on; a fresh answer is still required once.
  expect(den.readCachedDenDesktopConfig(cacheKey)?.dashboardEnabled).toBe(true);
  expect(artifacts).toEqual({ enabled: false, loading: false });
});
