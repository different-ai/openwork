import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  composeElectronIpc,
  defineIpcContribution,
  ELECTRON_IPC_INVENTORY_V1,
  ipcHandle,
  ipcListener,
} from "./ipc-composition.mjs";

const EXPECTED_LEGACY_CHANNEL_ORDER = [
  "handle:openwork:desktop",
  "handle:openwork:shell:openExternal",
  "handle:openwork:shell:relaunch",
  "handle:openwork:system:architecture",
  "handle:openwork:system:microphoneStatus",
  "handle:openwork:system:askMicrophoneAccess",
  "handle:openwork:terminal:create",
  "handle:openwork:terminal:write",
  "handle:openwork:terminal:resize",
  "handle:openwork:terminal:kill",
  "handle:openwork:browser:show",
  "handle:openwork:browser:hide",
  "handle:openwork:browser:openUrl",
  "handle:openwork:browser:navigate",
  "handle:openwork:browser:back",
  "handle:openwork:browser:forward",
  "handle:openwork:browser:reload",
  "handle:openwork:browser:bounds",
  "handle:openwork:browser:state",
  "handle:openwork:browser:createTab",
  "handle:openwork:browser:closeTab",
  "handle:openwork:browser:closeAllTabs",
  "handle:openwork:browser:selectTab",
  "handle:openwork:browser:reorderTabs",
  "handle:openwork:browser:listTabs",
  "handle:openwork:browser:setProxy",
  "handle:openwork:browser:getProxy",
  "handle:openwork:browser:tabContextMenu",
  "handle:openwork:browser:destroy",
  "listen:openwork:menu-overlay:ready",
  "listen:openwork:menu-overlay:choose",
  "listen:openwork:menu-overlay:close",
  "listen:openwork:menu-overlay:dismiss",
  "handle:openwork:migration:read",
  "handle:openwork:migration:ack",
  "handle:openwork:updater:getChannel",
  "handle:openwork:updater:setChannel",
  "handle:openwork:updater:check",
  "handle:openwork:updater:download",
  "handle:openwork:updater:installAndRestart",
];

function fakeIpcMain() {
  const calls = [];
  return {
    calls,
    handle(channel, handler) {
      calls.push({ kind: "handle", channel, handler });
    },
    on(channel, handler) {
      calls.push({ kind: "listen", channel, handler });
    },
  };
}

describe("Electron IPC composition", () => {
  it("pins the exact legacy registration inventory and order", () => {
    assert.deepEqual(
      ELECTRON_IPC_INVENTORY_V1.map(({ kind, channel }) => `${kind}:${channel}`),
      EXPECTED_LEGACY_CHANNEL_ORDER,
    );
    assert.equal(ELECTRON_IPC_INVENTORY_V1.length, 40);
  });

  it("binds contributions in declared order after validation", () => {
    const ipcMain = fakeIpcMain();
    const first = () => "first";
    const second = () => "second";
    const contribution = defineIpcContribution({
      id: "test.ordered.v1",
      registrations: [
        ipcHandle("test:first", first),
        ipcListener("test:second", second),
      ],
    });

    const composition = composeElectronIpc({ ipcMain, contributions: [contribution] });

    assert.deepEqual(composition.inventory, [
      { owner: "test.ordered.v1", kind: "handle", channel: "test:first" },
      { owner: "test.ordered.v1", kind: "listen", channel: "test:second" },
    ]);
    assert.deepEqual(ipcMain.calls, [
      { kind: "handle", channel: "test:first", handler: first },
      { kind: "listen", channel: "test:second", handler: second },
    ]);
  });

  it("rejects duplicate channels before registering anything", () => {
    const ipcMain = fakeIpcMain();
    const first = defineIpcContribution({
      id: "test.first.v1",
      registrations: [ipcHandle("test:duplicate", () => undefined)],
    });
    const second = defineIpcContribution({
      id: "test.second.v1",
      registrations: [ipcListener("test:duplicate", () => undefined)],
    });

    assert.throws(
      () => composeElectronIpc({ ipcMain, contributions: [first, second] }),
      /Duplicate Electron IPC channel: test:duplicate/,
    );
    assert.deepEqual(ipcMain.calls, []);
  });

  it("rejects inventory drift before registering anything", () => {
    const ipcMain = fakeIpcMain();
    const contribution = defineIpcContribution({
      id: "test.inventory.v1",
      registrations: [ipcHandle("test:actual", () => undefined)],
    });

    assert.throws(
      () => composeElectronIpc({
        ipcMain,
        contributions: [contribution],
        expectedInventory: [{ owner: "test.inventory.v1", kind: "handle", channel: "test:expected" }],
      }),
      /inventory mismatch at index 0/,
    );
    assert.deepEqual(ipcMain.calls, []);
  });
});
