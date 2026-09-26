/** @jsxImportSource react */
import { afterAll, afterEach, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { SessionRenderModel } from "../src/react-app/domains/session/sync/transition-controller";

import { SessionDebugPanel } from "../src/react-app/domains/session/surface/debug-panel";

const ownedDom = typeof window === "undefined";
if (ownedDom) GlobalRegistrator.register({ url: "http://localhost/" });
const actEnvironment = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
afterAll(async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
  if (ownedDom) await GlobalRegistrator.unregister();
});

const model: SessionRenderModel = {
  intendedSessionId: "session-a",
  renderedSessionId: null,
  transitionState: "idle",
  renderSource: "cache",
};

function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  cleanups.push(async () => { await act(async () => root.unmount()); container.remove(); });
  return {
    container,
    async render() {
      await act(async () => root.render(<SessionDebugPanel model={model} snapshot={null} />));
    },
  };
}

test("renders the session render state", async () => {
  const view = mount();
  await view.render();
  const panel = view.container.querySelector("[data-openwork-debug-panel]");
  if (!panel) throw new Error("Missing debug panel");
  expect(panel.textContent).toContain("intendedSessionId");
  expect(panel.textContent).toContain("session-a");
  expect(panel.textContent).toContain("transitionState");
  expect(panel.textContent).toContain("cache");
});

test("dismisses the panel when the close button is clicked", async () => {
  const view = mount();
  await view.render();
  const close = view.container.querySelector('button[aria-label="Close debug panel"]');
  if (!close) throw new Error("Missing close button");
  await act(async () => {
    close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  expect(view.container.querySelector("[data-openwork-debug-panel]")).toBeNull();
});