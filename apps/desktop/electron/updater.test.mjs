import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
          getVersion: () => "0.18.3",
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
        currentVersion: "0.18.3",
      });
    } finally {
      await rm(userData, { recursive: true, force: true });
    }
  });
});
