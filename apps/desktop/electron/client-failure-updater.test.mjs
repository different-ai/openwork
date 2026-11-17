import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { registerUpdaterIpc } from "./updater.mjs";

test("real updater check, download and install handlers build only fixed failures", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "updater-failure-"));
  const failures = [];
  const previous = globalThis.__openworkClientFailureReport;
  globalThis.__openworkClientFailureReport = (failure) => failures.push(failure);
  const handlers = new Map();
  let failing = "check";
  const updater = Object.assign(new EventEmitter(), {
    setFeedURL() {},
    checkForUpdates: async () => {
      if (failing === "check") throw new Error("private upstream text");
      return { updateInfo: { version: "9.0.0" } };
    },
    downloadUpdate: async () => {
      if (failing === "download") throw Object.assign(new Error("private path"), { code: "ERR_UPDATER_CHECKSUM_MISMATCH" });
      updater.emit("update-downloaded", { version: "9.0.0" });
    },
    quitAndInstall: () => {
      if (failing === "install") throw Object.assign(new Error("private installer text"), { code: "EACCES" });
      updater.emit("error", new Error("private installer process failure"));
    },
  });
  registerUpdaterIpc({
    app: { isPackaged: true, getVersion: () => "1.0.0", getPath: (key) => path.join(directory, key) },
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) }, getMainWindow: () => null,
    loadAutoUpdater: async () => ({ autoUpdater: updater }), platform: "linux", arch: "x64", writeDefaults: async () => {},
  });
  try {
    await handlers.get("openwork:updater:check")();
    failing = "download";
    await handlers.get("openwork:updater:check")();
    await handlers.get("openwork:updater:download")();
    failing = "install";
    await handlers.get("openwork:updater:download")();
    await handlers.get("openwork:updater:installAndRestart")();
    failing = "async";
    await handlers.get("openwork:updater:installAndRestart")();
    assert.deepEqual(failures, [
      { component: "updater", phase: "check", reason: "unknown" },
      { component: "updater", phase: "download", reason: "checksum" },
      { component: "updater", phase: "install", reason: "permission" },
      { component: "updater", phase: "install", reason: "unknown" },
    ]);
  } finally {
    globalThis.__openworkClientFailureReport = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
