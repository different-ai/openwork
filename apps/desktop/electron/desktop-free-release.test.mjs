import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDesktopFreeBuildSettings, loadDesktopFreeReleaseSecret } from "./desktop-free-release.mjs";

const secret = Buffer.alloc(32, 7);
const generated = (version, reveal = () => secret) => async () => ({ version, reveal });

test("a packaged build uses the module generated for its exact version", async () => {
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: generated("1.2.3") }), { secret, source: "release" });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.4", environment: {}, importGenerated: generated("1.2.3") }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: generated("1.2.3", () => null) }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: generated("1.2.3", () => Buffer.alloc(16)) }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: async () => { throw new Error("missing"); } }), { secret: null, source: null });
});

test("only an exact-version disabled build applies the opt-out, and a dev key cannot override it", async () => {
  const environment = { OPENWORK_DISABLE_FREE_INFERENCE: "0", OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_RELEASE_SECRET: "test-only-dev-release-secret-5555555555555555" };
  const disabled = async () => ({ version: "1.2.3", disabled: true, reveal: () => secret });
  assert.equal(await applyDesktopFreeBuildSettings({ appVersion: "1.2.3", environment, importGenerated: disabled }), true);
  assert.equal(environment.OPENWORK_DISABLE_FREE_INFERENCE, "1");
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment, importGenerated: disabled }), { secret: null, source: null });
  for (const importGenerated of [generated("1.2.3"), disabled, async () => { throw new Error("missing"); }]) {
    const untouched = { OPENWORK_DISABLE_FREE_INFERENCE: "0" };
    assert.equal(await applyDesktopFreeBuildSettings({ appVersion: "1.2.4", environment: untouched, importGenerated }), false);
    assert.equal(untouched.OPENWORK_DISABLE_FREE_INFERENCE, "0");
  }
});

test("developer builds use the dev secret only in developer mode, and never a short one", async () => {
  const dev = "test-only-dev-release-secret-5555555555555555";
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "0.0.0-dev", environment: { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_RELEASE_SECRET: dev }, importGenerated: async () => { throw new Error("missing"); } }),
    { secret: Buffer.from(dev), source: "dev" });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "0.0.0-dev", environment: { OPENWORK_DEV_FREE_RELEASE_SECRET: dev }, importGenerated: async () => { throw new Error("missing"); } }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "0.0.0-dev", environment: { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_RELEASE_SECRET: "short" }, importGenerated: async () => { throw new Error("missing"); } }), { secret: null, source: null });
  // A packaged secret wins over an unset dev secret, and the dev secret wins in dev mode.
  assert.equal((await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: { OPENWORK_DEV_MODE: "1", OPENWORK_DEV_FREE_RELEASE_SECRET: dev }, importGenerated: generated("1.2.3") })).source, "dev");
});
