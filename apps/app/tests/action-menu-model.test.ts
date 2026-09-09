import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createElement } from "react";
import { createNativeMenuController, dispatchMenuAction, serializeMenuActions, type MenuAction } from "../src/components/ui/action-menu-model";

describe("action menus", () => {
  it("serializes explicit labels, enabled state, separators and submenus without React presentation or callbacks", () => {
    const actions: MenuAction[] = [
      {
        type: "item", id: "archive", label: "Archive", disabled: true, disabledReason: "Read-only workspace",
        icon: createElement("svg"), webContent: createElement("span", null, "Web-only content"),
        variant: "destructive", dataAttributes: { "data-test-action": true }, onSelect: () => {},
      },
      { type: "separator" },
      { type: "item", id: "group", label: "Move to group", submenu: [
        { type: "item", id: "group:one", label: "One", onSelect: () => {} },
      ] },
    ];
    assert.deepEqual(serializeMenuActions(actions), [
      { type: "item", id: "archive", label: "Archive (Read-only workspace)", enabled: false },
      { type: "separator" },
      { type: "item", id: "group", label: "Move to group", enabled: true, submenu: [
        { type: "item", id: "group:one", label: "One", enabled: true },
      ] },
    ]);
  });

  it("dispatches only the selected enabled leaf and rejects missing, disabled, ambiguous and submenu IDs", async () => {
    const called: string[] = [];
    const actions: MenuAction[] = [
      { type: "item", id: "branch", label: "Branch", onSelect: () => { called.push("message-a"); } },
      { type: "item", id: "disabled", label: "Disabled", disabled: true, onSelect: () => { called.push("disabled"); } },
      { type: "item", id: "group", label: "Group", disabled: true, submenu: [
        { type: "item", id: "blocked-child", label: "Child", onSelect: () => { called.push("blocked-child"); } },
      ] },
      { type: "item", id: "enabled-group", label: "Enabled group", submenu: [
        { type: "item", id: "nested", label: "Nested", onSelect: () => { called.push("nested"); } },
        { type: "item", id: "duplicate", label: "Duplicate", onSelect: () => { called.push("duplicate"); } },
      ] },
      { type: "item", id: "duplicate", label: "Duplicate", disabled: true, onSelect: () => { called.push("duplicate"); } },
    ];
    for (const id of [null, "", "missing", "disabled", "group", "blocked-child", "enabled-group", "duplicate"]) {
      assert.equal(await dispatchMenuAction(actions, id), false);
    }
    assert.deepEqual(called, []);
    assert.equal(await dispatchMenuAction(actions, "branch"), true);
    assert.equal(await dispatchMenuAction(actions, "nested"), true);
    assert.deepEqual(called, ["message-a", "nested"]);
  });

  it("keeps the point and editing opt-in on the request and the target callback local", async () => {
    const called: string[] = [];
    const controller = createNativeMenuController(async (request) => {
      assert.deepEqual(request, {
        point: { x: 12, y: 24 }, includeEditing: true,
        items: [{ type: "item", id: "bold", label: "Bold", enabled: true }],
      });
      return "bold";
    });
    assert.equal(await controller.show([
      { type: "item", id: "bold", label: "Bold", onSelect: () => { called.push("editor-a"); } },
    ], { point: { x: 12, y: 24 }, includeEditing: true }), true);
    assert.deepEqual(called, ["editor-a"]);
  });

  it("ignores a late reply after cancellation", async () => {
    let resolve!: (id: string | null) => void;
    const reply = new Promise<string | null>((settle) => { resolve = settle; });
    let calls = 0;
    let signal: AbortSignal | undefined;
    const controller = createNativeMenuController((_request, value) => { signal = value; return reply; });
    const pending = controller.show([
      { type: "item", id: "edit", label: "Edit", onSelect: () => { calls++; } },
    ], { point: { x: 0, y: 0 } });
    controller.cancel();
    assert.equal(signal?.aborted, true);
    resolve("edit");
    assert.equal(await pending, false);
    assert.equal(calls, 0);
  });

  it("supersedes requests on the same menu and across different rows without retargeting callbacks", async () => {
    const replies: ((id: string | null) => void)[] = [];
    const called: string[] = [];
    const show = () => new Promise<string | null>((resolve) => { replies.push(resolve); });
    const first = createNativeMenuController(show);
    const second = createNativeMenuController(show);
    const actions = (target: string): MenuAction[] => [
      { type: "item", id: "edit", label: "Edit", onSelect: () => { called.push(target); } },
    ];
    const old = first.show(actions("old"), { point: { x: 0, y: 0 } });
    const superseded = first.show(actions("superseded"), { point: { x: 1, y: 1 } });
    const current = second.show(actions("current"), { point: { x: 2, y: 2 } });
    for (const resolve of replies) resolve("edit");
    assert.deepEqual(await Promise.all([old, superseded, current]), [false, false, true]);
    assert.deepEqual(called, ["current"]);
  });

  it("treats dismissal, invalid replies and bridge errors as no selection, without retrying", async () => {
    let calls = 0;
    let requests = 0;
    const actions: MenuAction[] = [{ type: "item", id: "edit", label: "Edit", onSelect: () => { calls++; } }];
    for (const outcome of [null, "unknown", new Error("IPC unavailable")]) {
      const controller = createNativeMenuController(async () => {
        requests++;
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      assert.equal(await controller.show(actions, { point: { x: 0, y: 0 } }), false);
    }
    assert.equal(requests, 3);
    assert.equal(calls, 0);
  });
});
