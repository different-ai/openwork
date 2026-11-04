import assert from "node:assert/strict";
import test from "node:test";

import { buildApplicationMenuTemplate } from "./app-menu-template.mjs";

function recorder() {
  const calls = [];
  const record = (name) => (...args) => calls.push([name, ...args]);
  return {
    calls,
    actions: {
      openSettings: record("openSettings"),
      checkForUpdates: record("checkForUpdates"),
      newSession: record("newSession"),
      searchSessions: record("searchSessions"),
      commandPalette: record("commandPalette"),
      toggleSidebar: record("toggleSidebar"),
      zoom: record("zoom"),
      close: record("close"),
      openDocs: record("openDocs"),
    },
  };
}

function build({ isMac, isPackaged = true }) {
  const { calls, actions } = recorder();
  const template = buildApplicationMenuTemplate({ isMac, isPackaged, appName: "OpenWork", actions });
  return { calls, template };
}

function menu(template, label) {
  const found = template.find((item) => item.label === label || item.role === label);
  assert.ok(found, `missing ${label} menu`);
  assert.ok(Array.isArray(found.submenu));
  return found.submenu;
}

/** Every labelled or role item across the whole menu, hidden items included. */
function allItems(template) {
  return template.flatMap((top) => (Array.isArray(top.submenu) ? top.submenu : []))
    .filter((item) => item.type !== "separator");
}

function itemNamed(template, label) {
  const found = allItems(template).find((item) => item.label === label);
  assert.ok(found, `missing ${label}`);
  return found;
}

for (const isMac of [true, false]) {
  const platform = isMac ? "macOS" : "Windows/Linux";

  test(`${platform}: every menu item appears once`, () => {
    const { template } = build({ isMac });
    const names = allItems(template).map((item) => item.label ?? item.role);
    const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
    assert.deepEqual(duplicates, []);
  });

  test(`${platform}: no menu starts, ends or doubles up on a separator`, () => {
    const { template } = build({ isMac, isPackaged: false });
    for (const top of template) {
      const visible = top.submenu.filter((item) => item.visible !== false);
      assert.notEqual(visible[0]?.type, "separator", `${top.label ?? top.role} starts with a separator`);
      assert.notEqual(visible.at(-1)?.type, "separator", `${top.label ?? top.role} ends with a separator`);
      visible.forEach((item, index) => {
        if (index === 0) return;
        assert.ok(
          !(item.type === "separator" && visible[index - 1].type === "separator"),
          `${top.label ?? top.role} has two separators in a row`,
        );
      });
    }
  });

  test(`${platform}: Settings is reachable once with the platform shortcut`, () => {
    const { template, calls } = build({ isMac });
    const settings = allItems(template).filter((item) => /^Settings/.test(item.label ?? ""));
    assert.equal(settings.length, 1);
    assert.equal(settings[0].accelerator, isMac ? "Command+," : "Control+,");
    assert.ok(!menu(template, "Edit").some((item) => /Settings/.test(item.label ?? "")));
    settings[0].click();
    assert.deepEqual(calls, [["openSettings"]]);
  });

  test(`${platform}: renderer-owned shortcuts are shown but not registered`, () => {
    const { template, calls } = build({ isMac });
    for (const [label, accelerator, action] of [
      ["New Session", "CommandOrControl+N", "newSession"],
      ["Search Sessions…", "CommandOrControl+Shift+F", "searchSessions"],
      ["Command Palette…", "CommandOrControl+K", "commandPalette"],
    ]) {
      const item = itemNamed(template, label);
      assert.equal(item.accelerator, accelerator);
      assert.equal(item.registerAccelerator, false, `${label} would fire twice`);
      item.click();
      assert.deepEqual(calls.at(-1), [action]);
    }
  });

  test(`${platform}: Close lives in File only`, () => {
    const { template } = build({ isMac });
    assert.ok(menu(template, "File").some((item) => item.label === "Close"));
    assert.ok(!menu(template, "Window").some((item) => item.label === "Close"));
  });

  test(`${platform}: zoom uses the keys people press and goes through the renderer`, () => {
    const { template, calls } = build({ isMac });
    const zoomIn = itemNamed(template, "Zoom In");
    assert.equal(zoomIn.accelerator, "CommandOrControl+=");
    zoomIn.click();
    itemNamed(template, "Zoom Out").click();
    itemNamed(template, "Actual Size").click();
    assert.deepEqual(calls, [["zoom", "in"], ["zoom", "out"], ["zoom", "reset"]]);
    assert.ok(!allItems(template).some((item) => ["zoomIn", "zoomOut", "resetZoom"].includes(item.role)));
  });

  test(`${platform}: packaged builds cannot reload the app from the keyboard`, () => {
    const packaged = build({ isMac, isPackaged: true }).template;
    const roles = allItems(packaged).map((item) => item.role);
    assert.ok(!roles.includes("reload"));
    assert.ok(!roles.includes("forceReload"));
    const devTools = allItems(packaged).find((item) => item.role === "toggleDevTools");
    assert.equal(devTools?.visible, false);

    const development = build({ isMac, isPackaged: false }).template;
    const devRoles = allItems(development).map((item) => item.role);
    assert.ok(devRoles.includes("reload"));
    assert.ok(devRoles.includes("toggleDevTools"));
  });

  test(`${platform}: Help opens shortcuts and docs`, () => {
    const { template, calls } = build({ isMac });
    const help = menu(template, "help");
    help.find((item) => item.label === "Keyboard Shortcuts").click();
    help.find((item) => item.label === "OpenWork Documentation").click();
    assert.deepEqual(calls, [["openSettings", "shortcuts"], ["openDocs"]]);
    assert.equal(help.some((item) => item.label === "Check for Updates…"), !isMac);
  });
}

test("macOS app menu uses the app name", () => {
  const { template } = build({ isMac: true });
  const appMenu = template[0];
  assert.equal(appMenu.label, "OpenWork");
  const labels = appMenu.submenu.map((item) => item.label).filter(Boolean);
  assert.ok(labels.includes("About OpenWork"));
  assert.ok(labels.includes("Quit OpenWork"));
  assert.ok(labels.includes("Check for Updates…"));
});
