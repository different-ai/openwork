import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import { applyBrandAppName } from "../electron/brand-app-name.mjs";
import { resetMacDockIcon } from "../electron/brand-icon-darwin.mjs";
import { applyWindowsTaskbarIcon } from "../electron/brand-icon-windows.mjs";
import { applyDesktopBootstrapBrandIcon } from "../electron/connect-link-branding.mjs";

// Exercise the actual native functions without booting an Electron UI or
// contacting a provider. This slice is function definitions, not a copy of the
// implementation: native queue, fetch cancellation and cache code stay covered.
const main = await readFile(new URL("../electron/main.mjs", import.meta.url), "utf8");
const nativeSource = main.slice(main.indexOf("let brandIconApplySequence = 0;"), main.indexOf("async function cleanupLegacyNativeIdentity()"));

async function fixture(t, initialConfig = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "white-label-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let config = initialConfig;
  const icons = [];
  const names = [];
  let fetches = 0;
  let fetcher = async () => ({ ok: true, headers: new Headers(), arrayBuffer: async () => Buffer.from("new icon") });
  const image = { isEmpty: () => false, getSize: () => ({ width: 128, height: 128 }), toPNG: () => Buffer.from("new icon") };
  const context = vm.createContext({
    Buffer, URL, AbortController, setTimeout, clearTimeout, console, path, existsSync, readFileSync,
    readFile, writeFile, mkdir, rename, rm,
    process: { platform: "darwin", pid: process.pid, title: "OpenWork" },
    workspaceStore: { readDesktopBootstrapConfigSync: () => config },
    BLANK_SLATE_LAUNCH: { enabled: false }, DESKTOP_DISTRIBUTION: {},
    desktopActivationRequired: () => false,
    app: { getPath: () => root, getVersion: () => "test", setName: (name) => names.push(name), dock: { setIcon: (icon) => icons.push(icon) } },
    applicationMenu: { setAppName: () => {} }, mainWindow: null,
    applyBrandAppName, resetMacDockIcon, currentDisplayAppName: "OpenWork",
    APP_NAME: "OpenWork", APP_IDENTIFIER: "com.differentai.openwork", APP_ICON_IMAGE: null,
    BRAND_ICON_FETCH_TIMEOUT_MS: 1000, BRAND_ICON_MAX_BYTES: 2097152, BRAND_ICON_FETCH_USER_AGENT: "test",
    nativeImage: { createFromPath: () => image, createFromBuffer: () => image },
    electronNet: { fetch: (...args) => { fetches++; return fetcher(...args); } },
  });
  const native = vm.runInContext(`${nativeSource}\n({ reconcileNativeBrand, applyBrandIconUrl, cancelNativeBrandApply, getBrandIconState, idle: () => nativeBrandQueue })`, context);
  return { root, native, icons, names, context, fetches: () => fetches, setConfig: (next) => { config = next; }, setFetcher: (next) => { fetcher = next; } };
}

const custom = { whiteLabelEnabled: true, brandAppName: "Organization Desktop", brandIconUrl: "https://assets.example.test/icon.png" };

test("native unknown/false state is stock without fetching or deleting source images", async (t) => {
  for (const flag of [undefined, false]) {
    const config = { ...custom, whiteLabelEnabled: flag };
    const f = await fixture(t, config);
    await writeFile(path.join(f.root, "brand-icon.png"), "original icon");
    await writeFile(path.join(f.root, "brand-icon.json"), JSON.stringify({ sourceUrl: custom.brandIconUrl }));
    await f.native.reconcileNativeBrand(config);
    assert.equal(f.fetches(), 0);
    assert.equal(f.names.at(-1), "OpenWork");
    assert.equal(f.icons.at(-1), null);
    assert.equal(await readFile(path.join(f.root, "brand-icon.png"), "utf8"), "original icon");
    assert.equal((await f.native.getBrandIconState()).applied, false);
  }
});

test("native ON, OFF, re-enable and offline restart use only last explicit flag and matching cache", async (t) => {
  const f = await fixture(t, custom);
  await f.native.reconcileNativeBrand(custom);
  assert.equal(f.fetches(), 1);
  assert.equal(f.names.at(-1), custom.brandAppName);
  assert.equal((await f.native.getBrandIconState()).applied, true);
  const bytes = await readFile(path.join(f.root, "brand-icon.png"));
  const sidecar = await readFile(path.join(f.root, "brand-icon.json"));
  const disabled = { ...custom, whiteLabelEnabled: false };
  f.native.cancelNativeBrandApply();
  await f.native.idle();
  f.setConfig(disabled);
  await f.native.reconcileNativeBrand(disabled);
  assert.equal(f.names.at(-1), "OpenWork");
  assert.equal(f.icons.at(-1), null);
  assert.deepEqual(await readFile(path.join(f.root, "brand-icon.png")), bytes);
  assert.deepEqual(await readFile(path.join(f.root, "brand-icon.json")), sidecar);
  f.setConfig(custom);
  f.setFetcher(() => { throw new Error("offline"); });
  await f.native.reconcileNativeBrand(custom);
  assert.equal(f.fetches(), 1);
  assert.equal((await f.native.getBrandIconState()).applied, true);
  // A fresh native process restores the cache only for explicit ON, even offline.
  const restarted = await fixture(t, custom);
  await writeFile(path.join(restarted.root, "brand-icon.png"), bytes);
  await writeFile(path.join(restarted.root, "brand-icon.json"), sidecar);
  restarted.setFetcher(() => { throw new Error("offline"); });
  await restarted.native.reconcileNativeBrand(custom);
  assert.equal(restarted.fetches(), 0);
  assert.equal((await restarted.native.getBrandIconState()).applied, true);
});

test("disable aborts an in-flight fetch and stale work never applies or erases source cache", async (t) => {
  const f = await fixture(t, custom);
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  let aborted = false;
  f.setFetcher((_url, { signal }) => new Promise((_resolve, reject) => {
    started();
    signal.addEventListener("abort", () => { aborted = true; reject(new DOMException("aborted", "AbortError")); });
  }));
  const pending = f.native.reconcileNativeBrand(custom);
  await fetching;
  f.native.cancelNativeBrandApply();
  await pending;
  const disabled = { ...custom, whiteLabelEnabled: false };
  f.setConfig(disabled);
  await f.native.reconcileNativeBrand(disabled);
  assert.equal(aborted, true);
  assert.equal(f.names.at(-1), "OpenWork");
  assert.equal(f.icons.filter((icon) => icon !== null).length, 0);
  assert.equal(existsSync(path.join(f.root, "brand-icon.png")), false);
  assert.equal((await f.native.getBrandIconState()).applied, false);
});

test("an unowned Windows shortcut cannot block resetting the running app's stock identity", async (t) => {
  const f = await fixture(t, { ...custom, whiteLabelEnabled: false });
  const models = [];
  const applied = [];
  f.context.process.platform = "win32";
  f.context.app.setAppUserModelId = (id) => models.push(id);
  f.context.APP_ICON_IMAGE = { isEmpty: () => false };
  f.context.recordStockApply = () => applied.push("stock");
  // Simulate the ownership guard refusing both cleanup and stock destination
  // replacement. The production reset pipeline must still update the live app.
  const reset = vm.runInContext(`
    removeWindowsBrandShortcut = async () => { throw new Error("unowned shortcut"); };
    registerWindowsBrandShortcut = async () => { throw new Error("unowned destination"); };
    writeWindowsIconFile = async () => {};
    applyAppIconImage = async () => { recordStockApply(); return { ok: true }; };
    applyDefaultAppIconImage
  `, f.context);
  assert.equal((await reset()).ok, true);
  assert.deepEqual(models, ["com.differentai.openwork"]);
  assert.deepEqual(applied, ["stock"]);
});

test("Windows cancellation during Explorer refresh never stages stale identity or strands the taskbar", async () => {
  const calls = [];
  let current = true;
  await applyWindowsTaskbarIcon({
    isVisible: () => true,
    setSkipTaskbar: (value) => calls.push(["skip", value]),
    setAppDetails: (value) => calls.push(["details", value]),
    setIcon: (value) => calls.push(["icon", value]),
  }, { image: {}, appId: "test.brand", appIconPath: "/unused/icon.ico", relaunchCommand: "test", relaunchDisplayName: "Test", isCurrent: () => current }, async () => { current = false; });
  assert.deepEqual(calls, [["skip", true], ["skip", false]]);
});

test("bootstrap icon helper never fetches from config presence without explicit enablement", async () => {
  const applied = [];
  const apply = async (url) => { applied.push(url); };
  await applyDesktopBootstrapBrandIcon({ brandIconUrl: custom.brandIconUrl }, apply);
  await applyDesktopBootstrapBrandIcon({ ...custom, whiteLabelEnabled: false }, apply);
  assert.deepEqual(applied, []);
  await applyDesktopBootstrapBrandIcon(custom, apply);
  assert.deepEqual(applied, [custom.brandIconUrl]);
});
