import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computerActionError,
  disconnectLocked,
  disconnectOwnConfirm,
  disconnectOwnerName,
  disconnectTeamConfirm,
  disconnectedLine,
  disconnectedMessage,
  myComputerActions,
  removeConfirm,
  teamComputerActions,
} from "./computer-actions";
import { computerMenuEntries, type ComputerActionSet } from "./computer-action-controls";

test("a member is offered exactly what Den says they may do to a computer, in menu order", () => {
  assert.deepEqual(myComputerActions({ canRename: true, canDisconnect: true, canRemove: true }), ["rename", "disconnect", "remove"]);
  assert.deepEqual(myComputerActions({ canRename: true, canDisconnect: false, canRemove: true }), ["rename", "remove"]);
  assert.deepEqual(myComputerActions({ canRename: false, canDisconnect: true, canRemove: false }), ["disconnect"]);
  // A shared computer someone else registered: nothing to do, so no menu.
  assert.deepEqual(myComputerActions({ canRename: false, canDisconnect: false, canRemove: false }), []);
});

test("an admin disconnects and removes, and never renames someone else's computer", () => {
  assert.deepEqual(teamComputerActions({ canDisconnect: true, canRemove: false }), ["disconnect"]);
  assert.deepEqual(teamComputerActions({ canDisconnect: false, canRemove: true }), ["remove"]);
  assert.deepEqual(teamComputerActions({ canDisconnect: false, canRemove: false }), []);
});

test("a connected desktop shows a lock to someone without the permission, and nothing where there is nothing to do", () => {
  const desktop = { kind: "desktop", disconnectedAt: null, removedAt: null, canDisconnect: false, canRemove: false } as const;
  assert.ok(disconnectLocked(desktop, false));
  // With the permission and still nothing offered, Den decided: no lock to explain.
  assert.ok(!disconnectLocked(desktop, true));
  assert.ok(!disconnectLocked({ ...desktop, kind: "vm" }, false));
  assert.ok(!disconnectLocked({ ...desktop, disconnectedAt: "2026-11-10T12:00:00Z" }, false));
  assert.ok(!disconnectLocked({ ...desktop, removedAt: "2026-11-10T12:00:00Z" }, false));
  assert.ok(!disconnectLocked({ ...desktop, canRemove: true }, false));
});

test("the owner's confirm says what happens on their own computer", () => {
  assert.deepEqual(disconnectOwnConfirm("Work laptop"), {
    title: "Disconnect Work laptop?",
    description: "OpenWork on that computer is signed out and it stops taking tasks and sharing sessions. Sign in on it again to reconnect it.",
    action: "Disconnect",
  });
});

test("the admin's confirm names whose OpenWork is signed out of which organization", () => {
  assert.deepEqual(disconnectTeamConfirm("Alex's MacBook Pro", "Alex Morgan", "Fieldnotes Studio"), {
    title: "Disconnect Alex's MacBook Pro?",
    description: "Alex Morgan's OpenWork on that computer is signed out of Fieldnotes Studio and it stops taking tasks and sharing sessions. They can sign in on it again to reconnect it.",
    action: "Disconnect",
  });
  assert.equal(disconnectOwnerName({ owner: { memberId: "m", name: "Alex Morgan", email: "alex@example.com", former: false }, shared: false }), "Alex Morgan");
  assert.equal(disconnectOwnerName({ owner: { memberId: "m", name: null, email: "alex@example.com", former: false }, shared: false }), "alex@example.com");
  // Someone who left is never named by their placeholder address.
  assert.equal(disconnectOwnerName({ owner: { memberId: "m", name: null, email: "retired-usr_1@deleted.invalid", former: true }, shared: false }), "A former member");
  assert.match(disconnectTeamConfirm("Old Mac", "A former member", "Acme").description, /^A former member's OpenWork on that computer is signed out of Acme /);
});

test("removing says it only removes the entry", () => {
  assert.deepEqual(removeConfirm("Studio Mac"), {
    title: "Remove Studio Mac from the list?",
    description: "This only removes the entry. It doesn't stop or delete the computer.",
    action: "Remove",
  });
});

test("after a disconnect the page says whether the app was signed out, from what Den reports", () => {
  assert.equal(disconnectedLine(true), "Disconnected. OpenWork was signed out on that computer.");
  assert.equal(disconnectedLine(false), "Disconnected. It can't act as a computer until someone signs in on it again.");
  // Never a claim of signing out when Den did not end the sign-in.
  assert.doesNotMatch(disconnectedLine(false), /signed out/);
  assert.deepEqual(disconnectedMessage(true), { title: "Disconnected", description: "OpenWork was signed out on that computer." });
});

test("a refusal shows Den's sentence when it sent one, else a plain line, and never a bare code", () => {
  assert.equal(computerActionError("disconnect", 409, { error: "not_disconnectable", message: "Workbot's computers are not signed in, so there is nothing to disconnect." }),
    "Workbot's computers are not signed in, so there is nothing to disconnect.");
  assert.equal(computerActionError("disconnect", 409, { error: "not_disconnectable" }), "This computer can't be disconnected. Only a signed-in desktop can.");
  assert.equal(computerActionError("remove", 409, { error: "disconnect_first" }), "Disconnect this computer first, then remove it.");
  assert.equal(computerActionError("disconnect", 404, { error: "not_found" }), "This computer is no longer in the list. Refresh to see what changed.");
  assert.equal(computerActionError("disconnect", 403, { error: "forbidden" }), "You don't have permission to disconnect this computer.");
  assert.equal(computerActionError("rename", 403, null), "You don't have permission to rename this computer.");
  assert.equal(computerActionError("remove", 500, "<html>"), "Couldn't remove this computer. Try again.");
  assert.equal(computerActionError("rename", 401, {}), "Your session expired. Sign in again.");
  for (const status of [403, 404, 409, 500]) assert.doesNotMatch(computerActionError("disconnect", status, { error: "some_code" }), /some_code/);
});

function actionSet(actions: ComputerActionSet["actions"]): ComputerActionSet & { calls: string[] } {
  const calls: string[] = [];
  return {
    actions, name: "Work laptop", calls,
    disconnectConfirm: disconnectOwnConfirm("Work laptop"), removeConfirm: removeConfirm("Work laptop"),
    onDisconnect: async () => { calls.push("disconnect"); }, onRemove: async () => { calls.push("remove"); }, onRename: async () => { calls.push("rename"); },
  };
}

test("the row menu lists only what is offered; Disconnect and Remove ask first, Rename opens its dialog", async () => {
  const set = actionSet(["rename", "disconnect", "remove"]);
  let renameOpened = 0;
  const entries = computerMenuEntries(set, { idPrefix: "my-computer", id: "rdv_1", onRename: () => { renameOpened += 1; } });
  assert.deepEqual(entries.map((entry) => [entry.label, entry.testId, entry.destructive === true, entry.confirm?.title ?? null]), [
    ["Rename", "my-computer-rename-rdv_1", false, null],
    ["Disconnect", "my-computer-disconnect-rdv_1", true, "Disconnect Work laptop?"],
    ["Remove from list", "my-computer-remove-rdv_1", true, "Remove Work laptop from the list?"],
  ]);
  await entries[0]?.onSelect?.();
  assert.equal(renameOpened, 1);
  await entries[1]?.onSelect?.();
  await entries[2]?.onSelect?.();
  assert.deepEqual(set.calls, ["disconnect", "remove"]);

  const team = computerMenuEntries(actionSet(["disconnect"]), { idPrefix: "computer", id: "rdv_2", onRename: () => {} });
  assert.deepEqual(team.map((entry) => [entry.label, entry.testId]), [["Disconnect", "computer-disconnect-rdv_2"]]);
  assert.deepEqual(computerMenuEntries(actionSet([]), { idPrefix: "computer", id: "rdv_3", onRename: () => {} }), []);
});
