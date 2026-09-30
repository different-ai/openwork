/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useVisualViewportInset } from "../src/hooks/use-visual-viewport-inset";

test("viewport listener updates shell variables and removes listeners on unmount", async () => {
  const ownedDom = typeof window === "undefined";
  if (ownedDom) GlobalRegistrator.register();
  const previousViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 740, offsetTop: 0, scale: 1 });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const host = document.createElement("div");
  const root = createRoot(host);
  const style = document.documentElement.style;
  function Harness() { useVisualViewportInset(); return null; }
  try {
    await act(async () => root.render(<Harness />));
    expect(style.getPropertyValue("--chat-viewport-height")).toBe("740px");
    Object.assign(viewport, { height: 360, offsetTop: 90 });
    viewport.dispatchEvent(new Event("resize"));
    expect(style.getPropertyValue("--chat-viewport-height")).toBe("360px");
    expect(style.getPropertyValue("--chat-viewport-top")).toBe("90px");
    Object.assign(viewport, { offsetTop: 0 });
    viewport.dispatchEvent(new Event("scroll"));
    expect(style.getPropertyValue("--chat-viewport-top")).toBe("0px");
    Object.assign(viewport, { height: 180, scale: 2 });
    viewport.dispatchEvent(new Event("resize"));
    expect(style.getPropertyValue("--chat-viewport-height")).toBe("360px");
    Object.assign(viewport, { height: 740, scale: 1 });
    window.dispatchEvent(new Event("orientationchange"));
    expect(style.getPropertyValue("--chat-viewport-height")).toBe("740px");
  } finally {
    await act(async () => root.unmount());
    expect(style.getPropertyValue("--chat-viewport-height")).toBe("");
    viewport.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
    expect(style.getPropertyValue("--chat-viewport-top")).toBe("");
    if (previousViewport) Object.defineProperty(window, "visualViewport", previousViewport);
    else Reflect.deleteProperty(window, "visualViewport");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    if (ownedDom) await GlobalRegistrator.unregister();
  }
});
