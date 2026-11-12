import assert from "node:assert/strict";
import { test } from "node:test";
import { REMOTE_DEVICE_ACCESS_REASONS, type RemoteDeviceAccess } from "@openwork/types/den/remote-devices";
import { REMOTE_ACCESS_LABEL, remoteAccessChangeHint, remoteAccessNote, remoteAccessValue } from "./remote-access";

const MODES = ["off", "created", "all"] as const;
const REASONS = [...REMOTE_DEVICE_ACCESS_REASONS, null];
const access = (effective: RemoteDeviceAccess["effective"], reason: RemoteDeviceAccess["reason"]): RemoteDeviceAccess => ({ effective, reason, chosen: reason !== "not_chosen" });

test("the value says what other devices can do on the computer", () => {
  assert.equal(REMOTE_ACCESS_LABEL, "Other devices can");
  assert.equal(remoteAccessValue(access("off", null)), "Nothing");
  assert.equal(remoteAccessValue(access("created", null)), "Start tasks");
  assert.equal(remoteAccessValue(access("all", null)), "Start tasks and open sessions");
  // The value is what applies, whatever the reason.
  for (const reason of REASONS) assert.equal(remoteAccessValue(access("off", reason)), "Nothing");
});

test("to its owner, a computer says why less applies than they could expect: every value with every reason", () => {
  const expected: Record<string, string | null> = {
    "off/organization": "Your organization has turned this off.",
    "created/organization": "Your organization doesn't allow more.",
    "all/organization": "Your organization doesn't allow more.",
    "off/not_chosen": "Not allowed yet. Allow it in Settings › Devices on that computer.",
    "created/not_chosen": "Not allowed yet. Allow it in Settings › Devices on that computer.",
    "all/not_chosen": "Not allowed yet. Allow it in Settings › Devices on that computer.",
    "off/update_required": "Update OpenWork on this computer to allow it.",
    "created/update_required": "Update OpenWork on this computer to allow it.",
    "all/update_required": "Update OpenWork on this computer to allow it.",
    "off/null": "Turned off on that computer.",
    // Their own choice applies and something reaches the computer: nothing to add.
    "created/null": null,
    "all/null": null,
  };
  for (const effective of MODES) for (const reason of REASONS) {
    assert.equal(remoteAccessNote(access(effective, reason), "owner"), expected[`${effective}/${reason}`], `${effective}/${reason}`);
    // First person is the default.
    assert.equal(remoteAccessNote(access(effective, reason)), expected[`${effective}/${reason}`]);
  }
  assert.equal(Object.keys(expected).length, MODES.length * REASONS.length);
});

test("to an admin, the same facts are said about someone else's computer: every value with every reason", () => {
  const expected: Record<string, string | null> = {
    "off/organization": "Turned off for the organization.",
    "created/organization": "The organization doesn't allow more.",
    "all/organization": "The organization doesn't allow more.",
    "off/not_chosen": "Not allowed by its owner yet.",
    "created/not_chosen": "Not allowed by its owner yet.",
    "all/not_chosen": "Not allowed by its owner yet.",
    "off/update_required": "Needs an OpenWork update before its owner can allow it.",
    "created/update_required": "Needs an OpenWork update before its owner can allow it.",
    "all/update_required": "Needs an OpenWork update before its owner can allow it.",
    "off/null": "Turned off by its owner.",
    "created/null": null,
    "all/null": null,
  };
  for (const effective of MODES) for (const reason of REASONS) {
    const note = remoteAccessNote(access(effective, reason), "team");
    assert.equal(note, expected[`${effective}/${reason}`], `${effective}/${reason}`);
    // Never "your", "this computer" or an instruction: the admin reads it, the owner acts on it.
    if (note) assert.doesNotMatch(note, /\b[Yy]our\b|this computer|that computer|Allow it in|Update OpenWork|Settings/, note);
  }
  // Both voices have a note for exactly the same cases.
  for (const effective of MODES) for (const reason of REASONS) {
    assert.equal(remoteAccessNote(access(effective, reason), "owner") === null, remoteAccessNote(access(effective, reason), "team") === null);
  }
});

test("the owner is told where to change it only when changing it there does something the note has not said", () => {
  const hint = "Change it in Settings › Devices on that computer.";
  // Their own choice applies, whatever it is.
  for (const effective of MODES) assert.equal(remoteAccessChangeHint(access(effective, null)), hint);
  // The organization allows less than they chose: they can still narrow it or turn it off there.
  assert.equal(remoteAccessChangeHint(access("created", "organization")), hint);
  // The organization turned it off: nothing on the computer changes that.
  assert.equal(remoteAccessChangeHint(access("off", "organization")), null);
  // The note already says to allow it there, or that the app has to be updated first.
  for (const effective of MODES) {
    assert.equal(remoteAccessChangeHint(access(effective, "not_chosen")), null);
    assert.equal(remoteAccessChangeHint(access(effective, "update_required")), null);
  }
});
