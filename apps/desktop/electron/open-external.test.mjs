import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXTERNAL_OPEN_CAPTURE_FILENAME, openExternalUrl, shouldCaptureExternalOpens } from "./open-external.mjs";

const captureEnv = { OPENWORK_DEV_MODE: "1", OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS: "1" };

const inactiveCaptureCases = [
  { isPackaged: true, env: captureEnv },
  { isPackaged: undefined, env: captureEnv },
  { isPackaged: false, env: {} },
  { isPackaged: false, env: { OPENWORK_DEV_MODE: "1" } },
  { isPackaged: false, env: { OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS: "1" } },
  { isPackaged: false, env: { ...captureEnv, OPENWORK_DEV_MODE: "0" } },
  { isPackaged: false, env: { ...captureEnv, OPENWORK_EVAL_CAPTURE_EXTERNAL_OPENS: "true" } },
];

describe("external-open capture", () => {
  it("requires an unpackaged app and both exact opt-in flags", () => {
    assert.equal(shouldCaptureExternalOpens(false, captureEnv), true);
    for (const { isPackaged, env } of inactiveCaptureCases) {
      assert.equal(shouldCaptureExternalOpens(isPackaged, env), false);
    }
  });

  it("appends JSON-string URL lines only in the fixture userData directory", async (t) => {
    const userData = await mkdtemp(join(tmpdir(), "openwork-external-capture-test-"));
    t.after(() => rm(userData, { recursive: true, force: true }));
    const writes = [];
    let shellCalls = 0;
    let fallbackCalls = 0;
    const deps = {
      env: captureEnv,
      platform: "win32",
      loadElectron: async () => ({
        app: { isPackaged: false, getPath: (name) => { assert.equal(name, "userData"); return userData; } },
        shell: { openExternal: async () => { shellCalls += 1; } },
      }),
      appendCapture: async (path, data, options) => {
        writes.push({ path, data, options });
        await appendFile(path, data, options);
      },
      spawnProcess: () => { fallbackCalls += 1; return { unref() {} }; },
    };
    const urls = ["http://127.0.0.1:3005/dashboard/your-connections", "http://127.0.0.1:3005/dashboard/mcp-connections?value=\"quoted\"\nnext"];
    for (const url of urls) assert.deepEqual(await openExternalUrl(url, deps), { ok: true });
    const path = join(userData, EXTERNAL_OPEN_CAPTURE_FILENAME);
    assert.equal(await readFile(path, "utf8"), urls.map((url) => `${JSON.stringify(url)}\n`).join(""));
    assert.deepEqual(writes, urls.map((url) => ({ path, data: `${JSON.stringify(url)}\n`, options: { encoding: "utf8", mode: 0o600 } })));
    assert.equal(shellCalls, 0);
    assert.equal(fallbackCalls, 0);
  });

  it("keeps packaged and non-eval calls on the real opener without touching capture storage", async () => {
    for (const { isPackaged, env } of inactiveCaptureCases) {
      const opened = [];
      const url = "http://127.0.0.1:3005/dashboard/mcp-connections";
      const result = await openExternalUrl(url, {
        env,
        loadElectron: async () => ({
          app: { isPackaged, getPath: () => assert.fail("Capture storage must not be resolved") },
          shell: { openExternal: async (value) => { opened.push(value); } },
        }),
        appendCapture: async () => assert.fail("Capture must remain disabled"),
      });
      assert.deepEqual(result, { ok: true });
      assert.deepEqual(opened, [url]);
    }
  });

  it("retains the packaged Windows fallback even when capture flags are present", async () => {
    let fallbackCalls = 0;
    const result = await openExternalUrl("http://127.0.0.1:3005/dashboard/mcp-connections", {
      env: captureEnv,
      platform: "win32",
      loadElectron: async () => ({
        app: { isPackaged: true },
        shell: { openExternal: async () => { throw new Error("association broken"); } },
      }),
      appendCapture: async () => assert.fail("Packaged calls cannot capture"),
      spawnProcess: () => { fallbackCalls += 1; return { unref() {} }; },
    });
    assert.deepEqual(result, { ok: false, error: "association broken" });
    assert.equal(fallbackCalls, 1);
  });

  it("reports capture path and write failures without any OS fallback", async () => {
    for (const failure of ["path unavailable", "write failed"]) {
      let shellCalls = 0;
      let fallbackCalls = 0;
      const result = await openExternalUrl("http://127.0.0.1:3005/dashboard/your-connections", {
        env: captureEnv,
        platform: "win32",
        loadElectron: async () => ({
          app: { isPackaged: false, getPath: () => { if (failure === "path unavailable") throw new Error(failure); return "fixture-user-data"; } },
          shell: { openExternal: async () => { shellCalls += 1; } },
        }),
        appendCapture: async () => { throw new Error(failure); },
        spawnProcess: () => { fallbackCalls += 1; return { unref() {} }; },
      });
      assert.deepEqual(result, { ok: false, error: failure });
      assert.equal(shellCalls, 0);
      assert.equal(fallbackCalls, 0);
    }
  });

  it("does not fall back to an OS browser when capture times out", async () => {
    let fallbackCalls = 0;
    const result = await openExternalUrl("http://127.0.0.1:3005/dashboard/your-connections", {
      env: captureEnv,
      platform: "win32",
      timeoutMs: 1,
      loadElectron: async () => ({
        app: { isPackaged: false, getPath: () => "fixture-user-data" },
        shell: { openExternal: async () => assert.fail("Capture cannot open a browser") },
      }),
      appendCapture: () => new Promise(() => {}),
      spawnProcess: () => { fallbackCalls += 1; return { unref() {} }; },
    });
    assert.deepEqual(result, { ok: false, error: "timed out after 1ms" });
    assert.equal(fallbackCalls, 0);
  });
});

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
