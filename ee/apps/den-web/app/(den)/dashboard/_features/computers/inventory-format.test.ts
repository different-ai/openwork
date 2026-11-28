import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPUTER_INVENTORY_KINDS } from "@openwork/types/den/computer-inventory";
import { inventoryRunCode } from "./inventory-format";

const sandboxUnavailable = "This computer can't run the OpenWork sandbox.";
const devicesSetting = "Settings > Devices on this computer";

test("desktop sandbox access reports the number of shared folders", () => {
  assert.deepEqual(inventoryRunCode({ value: "sandbox", folders: 2 }, "desktop"), {
    value: "sandbox", label: "In sandbox, 2 folders", reason: null, setting: null, locked: false,
  });
  assert.equal(inventoryRunCode({ value: "sandbox", folders: 1 }, "desktop").label, "In sandbox, 1 folder");
});

test("only non-desktops show Not available yet, even with an older response", () => {
  assert.deepEqual(inventoryRunCode({ value: "not_available" }, "desktop"), {
    value: "no", label: "No", reason: sandboxUnavailable, setting: null, locked: true,
  });
  for (const kind of COMPUTER_INVENTORY_KINDS.filter((kind) => kind !== "desktop")) {
    assert.equal(inventoryRunCode({ value: "not_available" }, kind).label, "Not available yet");
  }
});

test("desktop reasons explain which check stopped access and where the owner chooses", () => {
  assert.equal(inventoryRunCode({ value: "no", reason: "sandbox_unavailable" }, "desktop", true).reason, sandboxUnavailable);
  assert.equal(inventoryRunCode({ value: "no", reason: "nothing_shared" }, "desktop").reason,
    `Its owner hasn't shared a folder with another computer yet. They choose in ${devicesSetting}.`);
  assert.equal(inventoryRunCode({ value: "no", reason: "not_chosen" }, "desktop").reason,
    `Its owner hasn't turned this on. They choose in ${devicesSetting}.`);
  assert.equal(inventoryRunCode({ value: "no", reason: "owner" }, "desktop", true).setting, devicesSetting);
  assert.equal(inventoryRunCode({ value: "no", reason: "owner" }, "desktop").setting, null);
  assert.equal(inventoryRunCode({ value: "no", reason: "organization" }, "desktop", true).setting, null);
  assert.equal(inventoryRunCode({ value: "no", reason: "revoked" }, "desktop").reason, "Access was revoked.");
});

test("cloud access keeps its scope and off reason", () => {
  assert.equal(inventoryRunCode({ value: "whole_computer" }, "cloud").label, "Yes, whole computer");
  assert.equal(inventoryRunCode({ value: "no", reason: "not_chosen" }, "cloud", true).reason, "Its owner has not chosen yet.");
});
