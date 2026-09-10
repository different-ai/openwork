import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { contextMenuTemplate, createNativeContextMenus, editingMenuTemplate } from "./context-menu.mjs";

const item = (id, overrides = {}) => ({ type: "item", id, label: id, ...overrides });
const request = (items = [item("rename")]) => ({ requestId: "request", items, point: { x: 10.5, y: 20 } });

function fixture() {
  const menus = [];
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: {}, focusedFrame: {}, isDestroyed: () => false, getZoomFactor: () => 2,
  });
  const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false, getContentSize: () => [800, 600] });
  const Menu = { buildFromTemplate(template) {
    const menu = { template, popup(options) { this.options = options; }, closePopup() { this.options.callback(); } };
    menus.push(menu);
    return menu;
  } };
  return { menus, contents, window, controller: createNativeContextMenus({ Menu, getWindow: () => window }) };
}

test("native templates whitelist fields and cannot execute disabled descendants", () => {
  const selections = [];
  const template = contextMenuTemplate([
    item("safe", { role: "quit", accelerator: "Command+Q", click() { throw new Error("untrusted callback"); } }),
    item("group", { enabled: false, submenu: [item("delete")] }),
  ], (id) => selections.push(id));
  assert.equal(template[0].role, undefined);
  assert.equal(template[0].accelerator, undefined);
  template[0].click();
  template[1].submenu[0].click();
  assert.deepEqual(selections, ["safe"]);
  assert.equal(template[1].submenu[0].enabled, false);
});

test("native templates reject ambiguous IDs, invalid values and unbounded trees", () => {
  for (const items of [[item("same"), item("same")], [item("x", { label: 1 })], [item("x", { enabled: "yes" })], Array.from({ length: 257 }, (_, i) => item(String(i)))]) {
    assert.throws(() => contextMenuTemplate(items, () => {}));
  }
  let deep = [item("leaf")];
  for (let i = 0; i < 6; i++) deep = [item(`level-${i}`, { submenu: deep })];
  assert.throws(() => contextMenuTemplate(deep, () => {}));
});

test("only the app main frame can request a native menu", async () => {
  const { controller, menus, contents } = fixture();
  await assert.rejects(controller.showFromRenderer({ sender: {}, senderFrame: contents.mainFrame }, request()));
  await assert.rejects(controller.showFromRenderer({ sender: contents, senderFrame: {} }, request()));
  await assert.rejects(controller.showFromRenderer({ sender: contents, senderFrame: contents.mainFrame }, { ...request(), point: { x: NaN, y: 0 } }));
  assert.equal(menus.length, 0);
});

test("popup keeps authoritative zoom and focused frame and resolves the selected ID once", async () => {
  const { controller, menus, contents, window } = fixture();
  const result = controller.showFromRenderer({ sender: contents, senderFrame: contents.mainFrame }, request());
  const menu = menus[0];
  assert.equal(menu.options.x, 21);
  assert.equal(menu.options.y, 40);
  assert.equal(menu.options.frame, contents.focusedFrame);
  assert.equal(menu.options.window, window);
  menu.template[0].click();
  menu.options.callback();
  assert.equal(await result, "rename");
  assert.equal(contents.listenerCount("did-start-navigation"), 0);
});

test("dismissal, supersession, blur, navigation and destruction discard stale actions", async () => {
  const { controller, menus, contents, window } = fixture();
  const first = controller.show(request());
  const second = controller.show(request());
  menus[0].template[0].click();
  assert.equal(await first, null);
  menus[1].options.callback();
  assert.equal(await second, null);
  for (const dismiss of [() => controller.close(), () => window.emit("blur"), () => contents.emit("did-start-navigation", {}, "", false, true), () => contents.emit("destroyed")]) {
    const result = controller.show(request());
    dismiss();
    menus.at(-1).template[0].click();
    assert.equal(await result, null);
    assert.equal(window.listenerCount("blur"), 0);
  }
});

test("editing uses Chromium edit flags, selected-text copy and dictionary actions", () => {
  const calls = [];
  const contents = { replaceMisspelling: (word) => calls.push(word), session: { addWordToSpellCheckerDictionary: (word) => calls.push(word) } };
  const template = editingMenuTemplate(contents, {
    isEditable: true, misspelledWord: "helo", dictionarySuggestions: ["hello"],
    editFlags: { canUndo: true, canRedo: false, canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
  });
  for (const action of template.slice(0, 2)) {
    assert.ok("click" in action && typeof action.click === "function");
    action.click();
  }
  assert.deepEqual(calls, ["hello", "helo"]);
  assert.deepEqual(template.filter((item) => "role" in item && item.role === "cut"), [{ role: "cut", enabled: false }]);
  assert.deepEqual(template.filter((item) => "role" in item && item.role === "paste"), [{ role: "paste", enabled: true }]);
  assert.deepEqual(editingMenuTemplate(contents, { selectionText: "selected", editFlags: { canCopy: true } }), [{ role: "copy", enabled: true }]);
  assert.deepEqual(editingMenuTemplate(contents, {}), []);
});

test("renderer cancellation closes only its exact current popup, including editing roles", async () => {
  const { controller, contents, menus } = fixture();
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const result = controller.showFromRenderer(event, { ...request(), includeEditing: true });
  assert.equal(controller.cancelFromRenderer({ sender: contents, senderFrame: {} }, "request"), false);
  assert.equal(controller.cancelFromRenderer(event, "old-request"), false);
  assert.equal(controller.cancelFromRenderer(event, "request"), true);
  assert.equal(await result, null);
  const next = controller.show({ ...request(), requestId: "new-request" });
  assert.equal(controller.cancelFromRenderer(event, "request"), false);
  menus.at(-1).template[0].click();
  assert.equal(await next, "rename");
});

test("inspection describes the open and last popups as plain data, and choose selects only an enabled leaf", async () => {
  const { controller, menus } = fixture();
  assert.deepEqual(controller.inspect(), { open: false, current: null, last: null });
  assert.equal(controller.choose("rename"), false, "nothing to choose before a popup");
  const items = [item("open"), item("group", { submenu: [item("nested")] }), { type: "separator" }, item("copy-url", { label: "Copy Link Address" }), item("blocked", { enabled: false })];
  const result = controller.show(request(items));
  const inspected = controller.inspect();
  assert.equal(inspected.open, true);
  assert.equal(inspected.last, null);
  assert.deepEqual(inspected.current, { requestId: "request", point: { x: 21, y: 40 }, items: [
    { type: "item", id: "open", label: "open", role: null, enabled: true },
    { type: "item", id: "group", label: "group", role: null, enabled: true, submenu: [{ type: "item", id: "nested", label: "nested", role: null, enabled: true }] },
    { type: "separator" },
    { type: "item", id: "copy-url", label: "Copy Link Address", role: null, enabled: true },
    { type: "item", id: "blocked", label: "blocked", role: null, enabled: false },
  ] });
  assert.ok(inspected.current.items.every((entry) => !("click" in entry)), "descriptions carry no callbacks");
  assert.equal(controller.choose("blocked"), false, "disabled items cannot be chosen");
  assert.equal(controller.choose("group"), false, "submenu parents cannot be chosen");
  assert.equal(controller.choose("missing"), false);
  assert.equal(controller.inspect().open, true, "refused choices leave the popup open");
  assert.equal(controller.choose("copy-url"), true);
  assert.equal(await result, "copy-url");
  assert.equal(controller.inspect().open, false, "a choice closes the popup");
  assert.equal(menus.length, 1, "choosing never rebuilds the menu");
  assert.deepEqual(controller.inspect().last, { ...inspected.current, selectedId: "copy-url" });
  const dismissed = controller.show(request());
  controller.close();
  assert.equal(await dismissed, null);
  assert.equal(controller.inspect().open, false);
  assert.equal(controller.inspect().last.selectedId, null, "dismissal records no selection");
});

test("formatting menus compose editing roles without renderer-supplied privileges", async () => {
  const { controller, menus } = fixture();
  const result = controller.show({ ...request(), includeEditing: true });
  assert.deepEqual(menus[0].template.filter((item) => item.role).map((item) => item.role), ["undo", "redo", "cut", "copy", "paste", "selectAll"]);
  menus[0].template.at(-1).click();
  assert.equal(await result, "rename");
});
