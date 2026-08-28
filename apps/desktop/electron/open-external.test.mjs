import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isCancelledNavigationError,
  isLoopbackHttpUrl,
  isLoopbackWebUrl,
  isSupportedExternalUrl,
  loadBrowserTabUrl,
  openExternalUrl,
  routeOpenworkDeepLink,
} from "./open-external.mjs";

describe("external URL policy", () => {
  it("allows supported external protocols and rejects unsupported schemes", () => {
    assert.equal(isSupportedExternalUrl("https://example.com"), true);
    assert.equal(isSupportedExternalUrl("http://example.com"), true);
    assert.equal(isSupportedExternalUrl("mailto:hello@example.com"), true);
    assert.equal(isSupportedExternalUrl("file:///tmp/report.html"), false);
    assert.equal(isSupportedExternalUrl("javascript:alert(1)"), false);
    assert.equal(isSupportedExternalUrl("openwork://connect"), false);
    assert.equal(isSupportedExternalUrl("not a url"), false);
  });

  it("recognizes exact loopback hosts without accepting lookalikes", () => {
    assert.equal(isLoopbackHttpUrl("http://localhost:4096"), true);
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:4096"), true);
    assert.equal(isLoopbackHttpUrl("http://[::1]:4096"), true);
    assert.equal(isLoopbackWebUrl("https://localhost:4096"), true);
    assert.equal(isLoopbackHttpUrl("http://localhost.example.com"), false);
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1.example.com"), false);
    assert.equal(isLoopbackHttpUrl("http://localhost@evil.example"), false);
    assert.equal(isLoopbackHttpUrl("https://localhost:4096"), false);
  });

  it("routes both OpenWork popup protocols through the deep-link callback", () => {
    const routed = [];
    const onDeepLink = (urls) => routed.push(urls);

    assert.equal(routeOpenworkDeepLink("openwork://connect?token=prod", onDeepLink), true);
    assert.equal(routeOpenworkDeepLink("openwork-dev://connect?token=dev", onDeepLink), true);
    assert.equal(routeOpenworkDeepLink("https://example.com", onDeepLink), false);
    assert.deepEqual(routed, [
      ["openwork://connect?token=prod"],
      ["openwork-dev://connect?token=dev"],
    ]);
  });
});

describe("browser tab navigation errors", () => {
  it("ignores only a coded ERR_ABORTED cancellation", async () => {
    const aborted = Object.assign(new Error("navigation aborted"), { code: "ERR_ABORTED" });
    assert.equal(isCancelledNavigationError(aborted), true);
    assert.equal(
      await loadBrowserTabUrl("https://example.com", async () => { throw aborted; }),
      undefined,
    );

    const messageOnly = new Error("ERR_ABORTED while loading https://example.com");
    assert.equal(isCancelledNavigationError(messageOnly), false);
    await assert.rejects(
      () => loadBrowserTabUrl("https://example.com", async () => { throw messageOnly; }),
      messageOnly,
    );
  });

  it("returns remote connection resets as controlled failures", async () => {
    const reset = Object.assign(new Error("connection reset"), { code: "ERR_CONNECTION_RESET" });
    assert.equal(isCancelledNavigationError(reset), false);
    await assert.rejects(
      () => loadBrowserTabUrl("https://example.com", async () => { throw reset; }),
      reset,
    );

    const messageOnly = new Error("ERR_CONNECTION_RESET (-101) loading 'https://example.com'");
    await assert.rejects(
      () => loadBrowserTabUrl("https://example.com", async () => { throw messageOnly; }),
      messageOnly,
    );
  });
});

describe("openExternalUrl", () => {
  it("rejects unsupported protocols without calling shell.openExternal", async () => {
    let opened = false;
    const result = await openExternalUrl("file:///tmp/report.html", {
      env: {},
      openExternal: async () => { opened = true; },
    });

    assert.deepEqual(result, { ok: false, error: 'External URL protocol "file:" is not allowed.' });
    assert.equal(opened, false);
  });

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
