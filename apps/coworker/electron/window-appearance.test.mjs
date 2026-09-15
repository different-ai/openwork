import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { bindWindowAppearance } from "./window-appearance.mjs";

test("closed windows release appearance listeners without accessing their destroyed native handle", () => {
  const theme = new EventEmitter();
  const contents = new EventEmitter();
  contents.send = () => {};
  const window = new EventEmitter();
  window.isFocused = () => false;
  window.setBackgroundColor = () => {};
  let destroyed = false;
  Object.defineProperty(window, "webContents", { get() {
    if (destroyed) throw new TypeError("Object has been destroyed");
    return contents;
  } });
  bindWindowAppearance(window, theme, "linux");
  assert.equal(theme.listenerCount("updated"), 1);
  assert.equal(contents.listenerCount("did-finish-load"), 1);
  destroyed = true;
  assert.doesNotThrow(() => window.emit("closed"));
  assert.equal(theme.listenerCount("updated"), 0);
  assert.equal(contents.listenerCount("did-finish-load"), 0);
  assert.equal(window.listenerCount("focus"), 0);
  assert.equal(window.listenerCount("blur"), 0);
});
