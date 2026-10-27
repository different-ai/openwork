import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { FLOATING_VIEW_PREFIX, attachFloatingViewWindow, floatingViewWindowOptions } from "./floating-view-window.mjs";

describe("floating view windows", () => {
  it("opens only empty pages under the reserved name as borderless windows", () => {
    const options = floatingViewWindowOptions({ url: "about:blank", frameName: `${FLOATING_VIEW_PREFIX}browser` });
    assert.equal(options?.frame, false);
    assert.equal(options?.transparent, true);
    assert.equal(options?.show, false);
    assert.equal(options?.webPreferences.preload, undefined);
    assert.equal(options?.webPreferences.sandbox, true);
    assert.equal(floatingViewWindowOptions({ url: "https://example.com", frameName: `${FLOATING_VIEW_PREFIX}browser` }), null);
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName: "" }), null);
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName: "anything-else" }), null);
    // The computer view's pop-out has its own handler.
    assert.equal(floatingViewWindowOptions({ url: "about:blank", frameName: "openwork-computer-view-1" }), null);
  });

  it("shows the window above other apps without taking focus, and never navigates it", () => {
    /** @type {unknown[][]} */
    const calls = [];
    /** @type {(event: { preventDefault: () => void }) => void} */
    let navigate = () => {};
    /** @type {() => unknown} */
    let openHandler = () => undefined;
    const child = {
      setAlwaysOnTop: (/** @type {unknown[]} */ ...args) => calls.push(["setAlwaysOnTop", ...args]),
      setVisibleOnAllWorkspaces: (/** @type {unknown[]} */ ...args) => calls.push(["setVisibleOnAllWorkspaces", ...args]),
      showInactive: () => calls.push(["showInactive"]),
      webContents: {
        setWindowOpenHandler: (/** @type {() => unknown} */ handler) => { openHandler = handler; },
        on: (/** @type {string} */ event, /** @type {(event: { preventDefault: () => void }) => void} */ handler) => { if (event === "will-navigate") navigate = handler; },
      },
    };
    attachFloatingViewWindow(child);
    assert.deepEqual(calls, [
      ["setAlwaysOnTop", true, "floating"],
      ["setVisibleOnAllWorkspaces", true, { visibleOnFullScreen: true }],
      ["showInactive"],
    ]);
    assert.deepEqual(openHandler(), { action: "deny" });
    let prevented = false;
    navigate({ preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
  });
});
