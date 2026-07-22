import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { openExternalUrl } from "./open-external.mjs";

describe("openExternalUrl", () => {
  it("reports success when shell.openExternal resolves", async () => {
    let openedUrl = "";
    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: async (url) => {
        openedUrl = url;
      },
      platform: "linux",
      timeoutMs: 20,
    });

    assert.deepEqual(result, { ok: true });
    assert.equal(openedUrl, "https://example.com");
  });

  it("attempts rundll32 fallback on Windows after shell.openExternal rejects", async () => {
    let spawnCall = null;
    let unrefCalled = false;

    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: async () => {
        throw new Error("association broken");
      },
      platform: "win32",
      spawnProcess: (command, args, options) => {
        spawnCall = { command, args, options };
        return {
          unref() {
            unrefCalled = true;
          },
        };
      },
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "association broken");
    assert.deepEqual(spawnCall, {
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", "https://example.com"],
      options: { detached: true, stdio: "ignore" },
    });
    assert.equal(unrefCalled, true);
  });

  it("does not attempt rundll32 fallback off Windows after shell.openExternal rejects", async () => {
    let spawnCalled = false;

    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: async () => {
        throw new Error("blocked");
      },
      platform: "darwin",
      spawnProcess: () => {
        spawnCalled = true;
        return { unref() {} };
      },
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "blocked");
    assert.equal(spawnCalled, false);
  });

  it("times out if shell.openExternal never settles", async () => {
    const result = await openExternalUrl("https://example.com", {
      env: {},
      openExternal: () => new Promise(() => {}),
      platform: "linux",
      timeoutMs: 1,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error, "timed out after 1ms");
  });

  it("simulates failure without calling shell.openExternal", async () => {
    let opened = false;
    let spawnCalled = false;

    const result = await openExternalUrl("https://example.com", {
      env: { OPENWORK_SIMULATE_OPEN_EXTERNAL_FAILURE: "1" },
      openExternal: async () => {
        opened = true;
      },
      platform: "win32",
      spawnProcess: () => {
        spawnCalled = true;
        return { unref() {} };
      },
      timeoutMs: 20,
    });

    assert.deepEqual(result, { ok: false, error: "simulated failure" });
    assert.equal(opened, false);
    assert.equal(spawnCalled, false);
  });
});
