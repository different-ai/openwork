import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkspaceStore } from "../electron/workspace-store.mjs";
import { desktopBootstrapFromConnectClaims } from "../electron/connect-link.mjs";

const target = { baseUrl: "https://den.example.test", apiBaseUrl: "https://api.example.test", requireSignin: true };
const original = { brandAppName: " Original desktop ", brandLogoUrl: "https://assets.example.test/original-logo.png", brandIconUrl: "https://assets.example.test/original-icon.png" };
const custom = { brandAppName: "New desktop", brandLogoUrl: "https://assets.example.test/logo.png", brandIconUrl: "https://assets.example.test/icon.png" };
async function fixture(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), "white-label-bootstrap-"));
  const bootstrapPath = path.join(root, "bootstrap.json");
  const prior = process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
  process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = bootstrapPath;
  t.after(async () => {
    if (prior === undefined) delete process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH;
    else process.env.OPENWORK_DESKTOP_BOOTSTRAP_PATH = prior;
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(bootstrapPath, JSON.stringify(config));
  const open = () => createWorkspaceStore({ app: { getPath: () => root }, defaultDenBaseUrl: target.baseUrl, defaultRequireSignin: false, forceRequireSignin: false });
  return { root, bootstrapPath, open, store: open() };
}
function assertBrand(config, expected) {
  for (const [key, value] of Object.entries(expected)) assert.equal(config[key], value);
}

test("explicit ON updates effective source; false stock compatibility preserves it for offline restart/re-enable", async (t) => {
  const { store, open, root } = await fixture(t, { ...target, ...original });
  assert.equal(store.readDesktopBootstrapConfigSync().whiteLabelEnabled, undefined);
  const enabled = await store.setDesktopBootstrapConfig({ ...target, ...custom, whiteLabelEnabled: true });
  assertBrand(enabled, custom);
  await writeFile(path.join(root, "brand-icon.png"), "source bytes");
  const disabled = await store.setDesktopBootstrapConfig({ ...target, whiteLabelEnabled: false, brandAppName: "OpenWork", brandLogoUrl: null, brandIconUrl: null });
  assertBrand(disabled, custom);
  assert.equal(disabled.whiteLabelEnabled, false);
  assert.equal(await readFile(path.join(root, "brand-icon.png"), "utf8"), "source bytes");
  assert.equal(open().readDesktopBootstrapConfigSync().whiteLabelEnabled, false);
  const reenabled = await store.setDesktopBootstrapConfig({ ...target, whiteLabelEnabled: true });
  assertBrand(reenabled, custom);
  assert.equal(open().readDesktopBootstrapConfigSync().whiteLabelEnabled, true);
  await store.setDesktopBootstrapConfig({ ...target, requireSignin: false });
  assert.equal(open().readDesktopBootstrapConfigSync().whiteLabelEnabled, true);
});

test("new Den target cannot inherit last explicit flag and missing flags never activate existing originals", async (t) => {
  const { store, open } = await fixture(t, { ...target, ...original, whiteLabelEnabled: true });
  await store.setDesktopBootstrapConfig({ ...target, baseUrl: "https://other.example.test" });
  const next = open().readDesktopBootstrapConfigSync();
  assert.notEqual(next.whiteLabelEnabled, true);
  assert.equal(Object.hasOwn(next, "brandIconUrl"), false);
});

test("receipt restoration is scoped source data only, never a feature or activation-policy override", async (t) => {
  const { store } = await fixture(t, { ...target, ...original, whiteLabelEnabled: true, requireActivation: false });
  const receipt = await store.getDesktopBootstrapConfig();
  await store.setDesktopBootstrapConfig({ ...target, brandAppName: null, brandLogoUrl: null, brandIconUrl: null, whiteLabelEnabled: false, requireActivation: true });
  const restored = await store.setDesktopBootstrapConfig({ ...target, restoreSnapshotId: receipt.rollbackSnapshotId, whiteLabelEnabled: false, requireActivation: true });
  assertBrand(restored, original);
  assert.equal(restored.whiteLabelEnabled, false);
  assert.equal(restored.requireActivation, true);
});

test("verified connection projection only carries custom source values for explicit backend ON", () => {
  const claim = { den: target, requireSignin: true, brand: { appName: custom.brandAppName, logoUrl: custom.brandLogoUrl, iconUrl: custom.brandIconUrl } };
  for (const whiteLabelEnabled of [undefined, false]) {
    const next = desktopBootstrapFromConnectClaims({ ...claim, whiteLabelEnabled });
    assert.equal(next.whiteLabelEnabled, false);
    assert.equal(Object.hasOwn(next, "brandAppName"), false);
    assert.equal(Object.hasOwn(next, "brandIconUrl"), false);
  }
  const enabled = desktopBootstrapFromConnectClaims({ ...claim, whiteLabelEnabled: true });
  assert.equal(enabled.whiteLabelEnabled, true);
  assertBrand(enabled, custom);
});
