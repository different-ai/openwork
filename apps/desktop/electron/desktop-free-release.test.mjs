import assert from "node:assert/strict";
import { test } from "node:test";
import { loadDesktopFreeReleaseSecret } from "./desktop-free-release.mjs";

const secret = Buffer.alloc(32, 7);
const generated = (version, reveal = () => secret) => async () => ({ version, reveal });

test("a packaged build uses the module generated for its exact version", async () => {
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: generated("1.2.3") }), { secret, source: "release" });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.4", environment: {}, importGenerated: generated("1.2.3") }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: generated("1.2.3", () => null) }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: generated("1.2.3", () => Buffer.alloc(16)) }), { secret: null, source: null });
  assert.deepEqual(await loadDesktopFreeReleaseSecret({ appVersion: "1.2.3", environment: {}, importGenerated: async () => { throw new Error("missing"); } }), { secret: null, source: null });
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
