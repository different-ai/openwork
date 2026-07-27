import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  preventPendingUpdaterInstall,
  registerUpdaterIpc,
  staleUpdaterStatePaths,
  targetedStableUpdaterFeed,
} from "./updater.mjs";

const fakeApp = { getPath: (key) => (key === "home" ? "/Users/test" : `/Users/test/${key}`) };

// Unpackaged builds resolve their version from package.json, so release bumps
// must not require touching this test.
const desktopVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

let isolatedUpdaterImportId = 0;

function fakeUpdaterHarness({ version }) {
  const listeners = new Map();
  const calls = [];
  const updater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    disableDifferentialDownload: false,
    allowPrerelease: false,
    allowDowngrade: false,
    on: (name, fn) => listeners.set(name, fn),
    setFeedURL: () => {},
    checkForUpdates: async () => ({ updateInfo: { version } }),
    downloadUpdate: async () => {
      calls.push("download");
    },
    quitAndInstall: () => {
      calls.push("quitAndInstall");
    },
  };
  return { updater, listeners, calls };
}

async function registerFakeUpdaterIpc({ version }) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openwork-updater-test-"));
  const handlers = new Map();
  const harness = fakeUpdaterHarness({ version });
  isolatedUpdaterImportId += 1;
  const updaterModuleUrl = new URL(
    `./updater.mjs?updater-lifecycle=${isolatedUpdaterImportId}`,
    import.meta.url,
  );
  const { registerUpdaterIpc: registerIsolatedUpdaterIpc } = await import(
    updaterModuleUrl.href
  );
  registerIsolatedUpdaterIpc({
    app: {
      isPackaged: true,
      getVersion: () => "0.17.0",
      getPath: (key) => path.join(tempDir, key),
    },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    getMainWindow: () => null,
    loadAutoUpdater: async () => ({ autoUpdater: harness.updater }),
  });
  return { tempDir, handlers, ...harness };
}

describe("staleUpdaterStatePaths", () => {
  it("targets the ShipIt cache on macOS", { skip: process.platform !== "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), [
      "/Users/test/Library/Caches/com.differentai.openwork.ShipIt",
    ]);
  });

  it("is a no-op off macOS", { skip: process.platform === "darwin" }, () => {
    assert.deepEqual(staleUpdaterStatePaths(fakeApp), []);
  });
});

describe("targetedStableUpdaterFeed", () => {
  it("builds a fixed GitHub release feed from a strict stable version", () => {
    assert.equal(
      targetedStableUpdaterFeed("0.17.22", "0.17.23"),
      "https://github.com/different-ai/openwork/releases/download/v0.17.23",
    );
  });

  it("rejects arbitrary URLs and prerelease targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "https://example.test/latest.yml"),
      /stable x\.y\.z format/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.22", "0.17.23-alpha.1"),
      /stable x\.y\.z format/,
    );
  });

  it("rejects equal and older targets", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.23"),
      /newer than the installed version/,
    );
    assert.throws(
      () => targetedStableUpdaterFeed("0.17.23", "0.17.22"),
      /newer than the installed version/,
    );
  });

  it("fails closed when the installed version cannot be compared", () => {
    assert.throws(
      () => targetedStableUpdaterFeed("unknown", "0.17.23"),
      /could not be validated/,
    );
  });
});

describe("installAndRestart", () => {
  it("refuses to invoke the installer before an update is downloaded", async () => {
    const handlers = new Map();
    registerUpdaterIpc({
      app: { isPackaged: false },
      ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
      getMainWindow: () => null,
    });

    const install = handlers.get("openwork:updater:installAndRestart");
    assert.equal(typeof install, "function");
    assert.deepEqual(await install(), {
      ok: false,
      reason: "update-not-downloaded",
    });
  });
});

describe("downloaded update lifecycle", () => {
  it("a transient failed check does not invalidate a downloaded update", async () => {
    const { tempDir, handlers, updater, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");
      const install = handlers.get("openwork:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true });
      updater.checkForUpdates = async () => {
        throw new Error("network flake");
      };
      const failedCheck = await check(null, "stable");
      assert.equal(failedCheck.available, false);
      assert.match(failedCheck.reason, /network flake/);
      assert.deepEqual(await install(), { ok: true });
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("an updater error event does not invalidate a downloaded update", async () => {
    const { tempDir, handlers, listeners, calls } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");
      const install = handlers.get("openwork:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true });
      const onError = listeners.get("error");
      assert.equal(typeof onError, "function");
      onError(new Error("network flake"));
      assert.deepEqual(await install(), { ok: true });
      assert.deepEqual(calls, ["download", "quitAndInstall"]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("a successful check reporting no update still blocks install", async () => {
    const { tempDir, handlers, updater } = await registerFakeUpdaterIpc({
      version: "0.17.1",
    });
    try {
      const check = handlers.get("openwork:updater:check");
      const download = handlers.get("openwork:updater:download");
      const install = handlers.get("openwork:updater:installAndRestart");
      assert.equal(typeof check, "function");
      assert.equal(typeof download, "function");
      assert.equal(typeof install, "function");

      assert.equal((await check(null, "stable")).available, true);
      assert.deepEqual(await download(), { ok: true });
      updater.checkForUpdates = async () => ({
        updateInfo: { version: "0.17.0" },
      });
      const currentCheck = await check(null, "stable");
      assert.equal(currentCheck.available, false);
      assert.deepEqual(await install(), {
        ok: false,
        reason: "update-not-downloaded",
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe("release channel changes", () => {
  it("prevents a previously downloaded update from installing on quit", () => {
    const updater = { autoInstallOnAppQuit: true };

    preventPendingUpdaterInstall(updater);
    assert.equal(updater.autoInstallOnAppQuit, false);
  });

  it("pins enterprise builds to their parallel stable manifest channel", async () => {
    const handlers = new Map();
    const userData = await mkdtemp(path.join(os.tmpdir(), "openwork-enterprise-updater-"));
    try {
      registerUpdaterIpc({
        app: {
          isPackaged: false,
          getVersion: () => desktopVersion,
          getPath: () => userData,
        },
        ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
        getMainWindow: () => null,
        manifestChannel: "enterprise",
      });

      const setChannel = handlers.get("openwork:updater:setChannel");
      assert.equal(typeof setChannel, "function");
      assert.deepEqual(await setChannel(null, "alpha"), {
        channel: "stable",
        feedUrl: "https://github.com/different-ai/openwork/releases/latest/download",
        currentVersion: desktopVersion,
      });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});
