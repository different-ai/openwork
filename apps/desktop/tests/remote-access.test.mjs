import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRemoteAccessManager,
  assertRemoteAccessSender,
} from "../electron/remote-access.mjs";

function fixture(options = {}) {
  const calls = [];
  const device = {
    id: "phone",
    name: "My phone",
    workspaceIds: ["one"],
    allWorkspaces: false,
    active: true,
  };
  let allowed = true,
    enabled = false;
  const runtime = {
    controls: {
      state: async () => ({
        devices: [device],
        workspaces: [{ id: "one", name: "Project" }],
        pending: [],
      }),
      pair: async () => ({
        qrDataURL: "data:image/svg+xml;base64,QR",
        payload: { secret: "one-time" },
      }),
      revoke: async (id) => {
        calls.push(["revoke", id]);
      },
    },
    stop: async () => {
      calls.push("stop");
    },
  };
  const manager = createRemoteAccessManager({
    featureEnabled: async () => allowed,
    readEnabled: async () => enabled,
    writeEnabled: async (value) => {
      enabled = value;
      calls.push(["save", value]);
    },
    readDevices: async () => [device],
    network: {
      ensure: async () => {
        calls.push("network");
        return { origin: "https://example.tail.test" };
      },
    },
    start: async () => {
      calls.push("start");
      return runtime;
    },
    ...options,
  });
  return {
    manager,
    calls,
    setAllowed: (value) => {
      allowed = value;
    },
    setEnabled: (value) => {
      enabled = value;
    },
  };
}

test("saved enablement restores once; concurrent requests share one lifecycle", async () => {
  const f = fixture();
  f.setEnabled(true);
  await Promise.all([
    f.manager.refresh(),
    f.manager.refresh(),
    f.manager.setEnabled(true),
  ]);
  assert.equal(f.calls.filter((c) => c === "start").length, 1);
  assert.equal((await f.manager.status()).phase, "ready");
  await f.manager.dispose();
  await f.manager.dispose();
  assert.equal(f.calls.filter((c) => c === "stop").length, 1);
  await assert.rejects(f.manager.setEnabled(true), /REMOTE_ACCESS_CLOSED/);
});

test("disable queued during startup stops the new listener and retains phones", async () => {
  const f = fixture();
  await Promise.all([f.manager.setEnabled(true), f.manager.setEnabled(false)]);
  const status = await f.manager.status();
  assert.equal(status.phase, "off");
  assert.equal(status.enabled, false);
  assert.equal(status.devices[0].id, "phone");
  assert.deepEqual(f.calls, [
    ["save", true],
    "network",
    "start",
    ["save", false],
    "stop",
  ]);
});

test("feature disable stops access, preserves user intent, and rejects pairing", async () => {
  const f = fixture();
  await f.manager.setEnabled(true);
  f.setAllowed(false);
  const status = await f.manager.refresh();
  assert.equal(status.phase, "unavailable");
  assert.equal(status.enabled, true);
  assert.equal(status.available, false);
  await assert.rejects(f.manager.pair(), /FEATURE_DISABLED/);
  assert.equal(f.calls.filter((c) => c === "stop").length, 1);
  f.setAllowed(true);
  await f.manager.refresh();
  assert.equal(f.calls.filter((c) => c === "start").length, 2);
  await f.manager.dispose();
});

test("failed startup is recoverable and never leaks upstream errors", async () => {
  let failing = true;
  const f = fixture({
    start: async () => {
      if (failing) throw new Error("secret token and local path");
      return {
        controls: {
          state: async () => ({ devices: [], workspaces: [], pending: [] }),
        },
        stop: async () => {},
      };
    },
  });
  const failed = await f.manager.setEnabled(true);
  assert.equal(failed.phase, "error");
  assert.equal(failed.errorCode, "REMOTE_ACCESS_FAILED");
  assert.ok(!JSON.stringify(failed).includes("secret"));
  failing = false;
  assert.equal((await f.manager.refresh()).phase, "ready");
  await f.manager.dispose();
});

test("permission checks run for each management action, including a kill before refresh", async () => {
  const f = fixture();
  await f.manager.setEnabled(true);
  f.setAllowed(false);
  await assert.rejects(f.manager.revoke("phone"), /FEATURE_DISABLED/);
  assert.ok(!f.calls.some((c) => Array.isArray(c) && c[0] === "revoke"));
  assert.equal(f.calls.filter((c) => c === "stop").length, 1);
});

test("invalid enabled values do not modify preference or network", async () => {
  const f = fixture();
  await assert.rejects(f.manager.setEnabled("true"), /INVALID_REQUEST/);
  assert.deepEqual(f.calls, []);
});

test("only the live main application frame can manage remote access", () => {
  const mainFrame = {},
    webContents = { mainFrame },
    window = { webContents, isDestroyed: () => false };
  assert.doesNotThrow(() =>
    assertRemoteAccessSender(
      { sender: webContents, senderFrame: mainFrame },
      window,
    ),
  );
  for (const event of [
    { sender: {}, senderFrame: mainFrame },
    { sender: webContents, senderFrame: {} },
    { sender: webContents },
  ]) {
    assert.throws(
      () => assertRemoteAccessSender(event, window),
      /UNTRUSTED_REMOTE_ACCESS_SENDER/,
    );
  }
  assert.throws(
    () => assertRemoteAccessSender({}, null),
    /UNTRUSTED_REMOTE_ACCESS_SENDER/,
  );
});
