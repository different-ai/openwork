import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FLOATING_VIEW_PREFIX, attachFloatingViewWindow, floatingViewWindowOptions } from "./floating-view-window.mjs";

describe("floating view windows", () => {
  it("opens only empty pages under the reserved name, as ordinary resizable windows", () => {
    const options = floatingViewWindowOptions({ url: "about:blank", frameName: `${FLOATING_VIEW_PREFIX}browser` });
    assert.equal(options?.show, false);
    assert.equal(options?.webPreferences.preload, undefined);
    assert.equal(options?.webPreferences.sandbox, true);
    // Nothing turns off what the system gives a window: no frameless card, no
    // staying above other apps, and it resizes, minimizes and full-screens.
    for (const key of /** @type {const} */ (["frame", "transparent", "alwaysOnTop", "skipTaskbar", "resizable", "minimizable", "maximizable", "fullscreenable"])) {
      assert.equal(options?.[key], undefined, key);
    }
    assert.equal(floatingViewWindowOptions({ url: "https://example.com", frameName: `${FLOATING_VIEW_PREFIX}browser` }), null);
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName: "" }), null);
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName: "anything-else" }), null);
    // The computer view's pop-out has its own handler.
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName: "openwork-computer-view-1" }), null);
  });

  it("keeps each platform's window controls beside the tab strip", () => {
    const frameName = `${FLOATING_VIEW_PREFIX}browser`;
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName, platform: "darwin" })?.titleBarStyle, "hiddenInset");
    assert.deepEqual(floatingViewWindowOptions({ url: "about:blank", frameName, platform: "win32" })?.titleBarOverlay, { height: 40 });
    assert.deepEqual(floatingViewWindowOptions({ url: "about:blank", frameName, platform: "linux" })?.titleBarOverlay, { height: 40 });
  });

  it("shows the window without taking focus, and never navigates it", () => {
    /** @type {unknown[][]} */
    const calls = [];
    /** @type {(event: { preventDefault: () => void }) => void} */
    let navigate = () => {};
    /** @type {() => unknown} */
    let openHandler = () => undefined;
    const child = {
      showInactive: () => calls.push(["showInactive"]),
      webContents: {
        setWindowOpenHandler: (/** @type {() => unknown} */ handler) => { openHandler = handler; },
        on: (/** @type {string} */ event, /** @type {(event: { preventDefault: () => void }) => void} */ handler) => { if (event === "will-navigate") navigate = handler; },
      },
    };
    attachFloatingViewWindow(child);
    assert.deepEqual(calls, [["showInactive"]]);
    assert.deepEqual(openHandler(), { action: "deny" });
    let prevented = false;
    navigate({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  });
});
