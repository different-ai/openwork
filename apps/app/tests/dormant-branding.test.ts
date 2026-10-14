import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import * as desktop from "../src/app/lib/desktop";
import {
  getDenDesktopConfigCacheKey,
  initializeDenBootstrapConfig,
  readCachedDenDesktopConfig,
  readDenBootstrapConfig,
  readDenSettings,
  refreshDenBootstrapConfigFromShell,
  setDenBootstrapConfig,
  writeCachedDenDesktopConfig,
  writeDenSettings,
} from "../src/app/lib/den";
import { exchangeHandoffAndSignIn } from "../src/app/lib/den-handoff";
import { desktopCapabilityConfig } from "@openwork/types/den/desktop-policies";

const branding = {
  brandAppName: "Legacy workspace",
  brandLogoUrl: "https://private.example.test/logo.svg?token=retained",
  brandIconUrl: "https://private.example.test/icon.png?token=retained",
};
const origin = "https://den.example.test";
let stored: desktop.DesktopBootstrapConfig = { baseUrl: origin, requireSignin: true, ...branding };
let written: unknown[] = [];
let restoreMocks: Array<() => void> = [];

beforeEach(async () => {
  GlobalRegistrator.register({ url: "http://localhost:5173/" });
  stored = { baseUrl: origin, requireSignin: true, ...branding };
  written = [];
  window.localStorage.setItem("openwork.den.activeOrgId", "org-a");
  Reflect.set(window, "__OPENWORK_ELECTRON__", { meta: { desktopBootstrap: stored } });
  const shellRead = spyOn(desktop, "getDesktopBootstrapConfig").mockImplementation(async () => stored);
  const shellWrite = spyOn(desktop, "setDesktopBootstrapConfig").mockImplementation(async (next) => {
    written.push(next);
    // Shell accepts source updates only when the projected flag is explicit;
    // off/missing retain existing same-origin settings for rollback.
    const sameOrigin = new URL(next.baseUrl).origin === new URL(stored.baseUrl).origin
      && (!next.apiBaseUrl || !stored.apiBaseUrl
        || new URL(next.apiBaseUrl).origin === new URL(stored.apiBaseUrl).origin);
    const { brandAppName, brandLogoUrl, brandIconUrl, ...active } = next;
    stored = {
      ...active,
      ...(sameOrigin ? {
        brandAppName: brandAppName === null ? null : next.whiteLabelEnabled === true ? brandAppName ?? stored.brandAppName : stored.brandAppName,
        brandLogoUrl: brandLogoUrl === null ? null : next.whiteLabelEnabled === true ? brandLogoUrl ?? stored.brandLogoUrl : stored.brandLogoUrl,
        brandIconUrl: brandIconUrl === null ? null : next.whiteLabelEnabled === true ? brandIconUrl ?? stored.brandIconUrl : stored.brandIconUrl,
      } : {}),
      requireSignin: next.requireSignin === true,
    };
    return stored;
  });
  const fetch = spyOn(desktop, "desktopFetchViaMain").mockImplementation(async (url) => {
    if (String(url).endsWith("/api/runtime-config")) return new Response("{}", { status: 200 });
    return Response.json({
      token: "new-session",
      organization: { id: "org-a", slug: "org-a", name: "Workspace" },
      brand: { appName: "OpenWork", logoUrl: null, iconUrl: null },
      connectEnabled: false,
    });
  });
  restoreMocks = [() => shellRead.mockRestore(), () => shellWrite.mockRestore(), () => fetch.mockRestore()];
  await initializeDenBootstrapConfig();
});

afterEach(async () => {
  for (const restore of restoreMocks) restore();
  await GlobalRegistrator.unregister();
});

test("upgrade, sign-in, refresh and an unrelated bootstrap write retain dormant identity", async () => {
  expect(readDenBootstrapConfig()).toMatchObject(branding);
  const result = await exchangeHandoffAndSignIn("one-time-grant", {
    baseUrl: origin,
    desktopInitiated: false,
    bootstrap: { clearHandoff: true },
  });
  expect(result.ok).toBe(true);
  expect(stored).toMatchObject(branding);
  await refreshDenBootstrapConfigFromShell();
  await setDenBootstrapConfig({ baseUrl: origin, requireSignin: false });
  expect(stored).toMatchObject({ ...branding, requireSignin: false });
  expect(readDenBootstrapConfig()).toMatchObject(branding);
  expect(written).toHaveLength(2);
});

test("a destructive bootstrap write fails closed if rollback storage is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
  const storage = window.localStorage;
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: storage.getItem.bind(storage),
      setItem: () => { throw new Error("storage unavailable"); },
    },
  });
  try {
    await expect(setDenBootstrapConfig({ baseUrl: "https://other.example.test" })).rejects.toThrow("storage unavailable");
    expect(stored).toMatchObject(branding);
    expect(written).toHaveLength(0);
  } finally {
    if (descriptor) Object.defineProperty(window, "localStorage", descriptor);
  }
});

test("same-origin writes cannot edit dormant identity", async () => {
  await setDenBootstrapConfig({
    baseUrl: origin,
    brandAppName: "New input",
    brandLogoUrl: "https://new-input.example.test/logo.svg",
  });
  expect(stored).toMatchObject(branding);
});

test("same-org flag toggles preserve bootstrap settings and allow new enabled server values", async () => {
  await setDenBootstrapConfig({ baseUrl: origin, whiteLabelEnabled: true, ...branding });
  await setDenBootstrapConfig({ baseUrl: origin, whiteLabelEnabled: false });
  expect(stored).toMatchObject({ ...branding, whiteLabelEnabled: false });
  expect(written.at(-1)).not.toMatchObject({ brandAppName: null });
  await setDenBootstrapConfig({ baseUrl: origin, whiteLabelEnabled: true });
  expect(stored).toMatchObject({ ...branding, whiteLabelEnabled: true });
  await setDenBootstrapConfig({ baseUrl: origin, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
  expect(stored).toMatchObject({ ...branding, brandAppName: "Updated workspace", whiteLabelEnabled: true });
});

test("same-org cache rollout rollback retains raw settings and ignores them until re-enabled", () => {
  writeDenSettings({ baseUrl: origin, authToken: "session", activeOrgId: "org-a" }, { persistBootstrap: false });
  const key = getDenDesktopConfigCacheKey();
  writeCachedDenDesktopConfig(key, { ...branding, whiteLabelEnabled: true });
  writeCachedDenDesktopConfig(key, { whiteLabelEnabled: false, brandAppName: "OpenWork" });
  expect(JSON.parse(window.localStorage.getItem(key) ?? "{}")).toMatchObject({ ...branding, whiteLabelEnabled: false });
  expect(desktopCapabilityConfig(readCachedDenDesktopConfig(key) ?? {})).toEqual({ whiteLabelEnabled: false });
  writeCachedDenDesktopConfig(key, { ...branding, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
  expect(readCachedDenDesktopConfig(key)).toMatchObject({ ...branding, whiteLabelEnabled: true, brandAppName: "Updated workspace" });
});

test("rollback cannot introduce arbitrary branding through a fabricated snapshot", async () => {
  const fabricated = { ...readDenBootstrapConfig(), brandAppName: "Arbitrary new name" };
  await expect(setDenBootstrapConfig({ baseUrl: origin }, { restoreSnapshot: fabricated }))
    .rejects.toThrow("previously read snapshot");
  expect(written).toHaveLength(0);
  expect(stored).toMatchObject(branding);
});

test("a cross-origin sign-in never persists the old origin's private URLs", async () => {
  const result = await exchangeHandoffAndSignIn("one-time-grant", {
    baseUrl: "https://other.example.test",
    desktopInitiated: false,
  });
  expect(result.ok).toBe(true);
  expect(JSON.stringify(stored)).not.toContain("private.example.test");
});

test("origin changes never carry private identity URLs, including caller-supplied legacy input", async () => {
  await setDenBootstrapConfig({ baseUrl: "https://other.example.test", ...branding });
  expect(JSON.stringify(stored)).not.toContain("private.example.test");
  expect(readDenBootstrapConfig().brandAppName).toBeUndefined();
});

test("org cache refresh retains existing identity but exposes only policies", () => {
  writeDenSettings({ baseUrl: origin, authToken: "session", activeOrgId: "org-a" }, { persistBootstrap: false });
  const key = getDenDesktopConfigCacheKey();
  window.localStorage.setItem(key, JSON.stringify({ ...branding, brandAccentColor: "purple", connectEnabled: true }));
  writeCachedDenDesktopConfig(key, { connectEnabled: false, allowCustomProviders: false });
  expect(JSON.parse(window.localStorage.getItem(key) ?? "{}")).toMatchObject(branding);
  expect(desktopCapabilityConfig(readCachedDenDesktopConfig(key) ?? {})).toEqual({ connectEnabled: false, allowCustomProviders: false });
  writeDenSettings({ ...readDenSettings(), activeOrgId: "org-b" }, { persistBootstrap: false });
  const otherKey = getDenDesktopConfigCacheKey();
  writeCachedDenDesktopConfig(otherKey, { connectEnabled: true });
  expect(window.localStorage.getItem(otherKey)).not.toContain("private.example.test");
  expect(window.localStorage.getItem(key)).toContain("private.example.test");
});

function archivedBootstrap(scopeOrigin: string, organizationId: string | null) {
  // The API may use a separate hosted origin, so inspect the stored scope
  // rather than assuming that it is the same as the web origin.
  const records = Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))
    .filter((entry): entry is string => entry?.startsWith("openwork.den.dormantBootstrap.v1::") === true)
    .map((entry) => JSON.parse(window.localStorage.getItem(entry) ?? "{}"));
  return records.find((entry) => entry.baseOrigin === scopeOrigin && entry.organizationId === organizationId)
    ?? null;
}

test("chooser null -> same org, including refresh, preserves bootstrap-only identity and its owner", async () => {
  writeDenSettings({ baseUrl: origin, authToken: "session", activeOrgId: null }, {
    persistBootstrap: false, intentionalActiveOrgClear: true,
  });
  await refreshDenBootstrapConfigFromShell();
  writeDenSettings({ ...readDenSettings(), activeOrgId: "org-a" }, { persistBootstrap: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stored).toMatchObject(branding);
  expect(archivedBootstrap(origin, "org-a").snapshots).toContainEqual(branding);
});

test("MDM/bootstrap-only identity without an org is archived before changing Den", async () => {
  window.localStorage.clear();
  await refreshDenBootstrapConfigFromShell();
  expect(archivedBootstrap(origin, null).snapshots).toContainEqual(branding);
  await setDenBootstrapConfig({ baseUrl: "https://other.example.test" });
  expect(JSON.stringify(stored)).not.toContain("private.example.test");
  expect(archivedBootstrap(origin, null).snapshots).toContainEqual(branding);
  expect(archivedBootstrap("https://other.example.test", null)).toBeNull();
});

test("archives retain original snapshots when trusted MDM settings change within a scope", async () => {
  stored = { ...stored, brandLogoUrl: "https://private.example.test/replacement.svg" };
  await refreshDenBootstrapConfigFromShell();
  expect(archivedBootstrap(origin, "org-a").snapshots).toContainEqual(branding);
  expect(archivedBootstrap(origin, "org-a").snapshots).toContainEqual({
    ...branding, brandLogoUrl: "https://private.example.test/replacement.svg",
  });
});

test("selecting a different organization archives bootstrap identity rather than destroying or reassigning it", async () => {
  writeDenSettings({ baseUrl: origin, authToken: "session", activeOrgId: "org-b" }, { persistBootstrap: false });
  // The settings API is synchronous; shell persistence completes asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(JSON.stringify(stored)).not.toContain("private.example.test");
  expect(archivedBootstrap(origin, "org-a").snapshots).toContainEqual(branding);
  expect(archivedBootstrap(origin, "org-b")).toBeNull();
  // An unrelated follow-up write must not overwrite the archived original with nulls.
  await setDenBootstrapConfig({ baseUrl: origin, requireSignin: false });
  expect(archivedBootstrap(origin, "org-a").snapshots).toContainEqual(branding);
});
