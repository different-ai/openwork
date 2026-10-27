import * as React from "react";

import { isElectronRuntime } from "@/app/lib/runtime-env";

// Must match FLOATING_VIEW_PREFIX in apps/desktop/electron/floating-view-window.mjs.
const FLOATING_VIEW_PREFIX = "openwork-floating-";
const EDGE = 16;

// Only the Electron shell turns the named window into a borderless one; a
// browser with a stubbed bridge (test fixtures) keeps the in-app layout.
function canFloat() {
  return isElectronRuntime() && /\bElectron\//.test(navigator.userAgent);
}

type FloatingWindowOptions = {
  /** Window title; never "OpenWork", which names the app's own page. */
  title: string;
  width: number;
  height: number;
  /** The person closed the window itself (for example with Cmd+W). */
  onClosed: () => void;
};

/**
 * Keeps the floating window's styles, theme and platform markers in step with
 * the app: a copy of every stylesheet, plus the root element's attributes.
 */
function mirrorDocument(source: Document, target: Document) {
  let copies: Node[] = [];
  let frame: number | null = null;
  const copyStyles = () => {
    frame = null;
    for (const node of copies) node.parentNode?.removeChild(node);
    copies = [];
    for (const node of source.head.querySelectorAll("link[rel~='stylesheet'], style")) {
      let copy: HTMLElement;
      if (node instanceof HTMLLinkElement) {
        const link = target.createElement("link");
        link.rel = "stylesheet";
        link.href = node.href;
        copy = link;
      } else {
        copy = target.createElement("style");
        copy.textContent = node.textContent;
      }
      target.head.appendChild(copy);
      copies.push(copy);
    }
  };
  const copyRoot = () => {
    const from = source.documentElement;
    const to = target.documentElement;
    for (const name of to.getAttributeNames()) if (!from.hasAttribute(name)) to.removeAttribute(name);
    for (const name of from.getAttributeNames()) to.setAttribute(name, from.getAttribute(name) ?? "");
    // Only the floating surface paints; the window itself stays see-through.
    to.style.background = "transparent";
  };
  copyStyles();
  copyRoot();
  // Vite updates styles in place during development; rebuild once per frame.
  const styles = new MutationObserver(() => {
    if (frame === null) frame = source.defaultView?.requestAnimationFrame(copyStyles) ?? null;
  });
  styles.observe(source.head, { childList: true, subtree: true, characterData: true });
  const root = new MutationObserver(copyRoot);
  root.observe(source.documentElement, { attributes: true });
  return () => {
    styles.disconnect();
    root.disconnect();
    if (frame !== null) source.defaultView?.cancelAnimationFrame(frame);
  };
}

/**
 * Opens a borderless desktop window that floats over every app and returns a
 * container inside it to portal into. Null outside the desktop app, before it
 * opens, or when the host refused it; callers then keep their in-app layout.
 */
export function useFloatingWindow(name: string, open: boolean, { title, width, height, onClosed }: FloatingWindowOptions): HTMLElement | null {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const closed = React.useEffectEvent(onClosed);
  const size = React.useRef({ width, height, title });
  size.current = { width, height, title };

  React.useLayoutEffect(() => {
    if (!open || !canFloat()) return;
    const { width: w, height: h, title: initialTitle } = size.current;
    const left = Math.round(window.screenX + window.outerWidth - w - EDGE);
    const top = Math.round(window.screenY + 64);
    const popup = window.open("about:blank", `${FLOATING_VIEW_PREFIX}${name}`, `popup,width=${w},height=${h},left=${left},top=${top}`);
    if (!popup) return;
    const doc = popup.document;
    doc.title = initialTitle;
    Object.assign(doc.body.style, { margin: "0", background: "transparent", overflow: "hidden" });
    const root = doc.createElement("div");
    root.dataset.floatingWindow = name;
    doc.body.appendChild(root);
    const stopMirror = mirrorDocument(document, doc);
    setContainer(root);
    let disposed = false;
    // A window the person closed reports it on the next check.
    const watch = window.setInterval(() => {
      if (!popup.closed || disposed) return;
      disposed = true;
      window.clearInterval(watch);
      stopMirror();
      setContainer(null);
      closed();
    }, 400);
    return () => {
      disposed = true;
      window.clearInterval(watch);
      stopMirror();
      setContainer(null);
      if (!popup.closed) popup.close();
    };
  }, [open, name]);

  React.useEffect(() => {
    if (container) container.ownerDocument.title = title;
  }, [container, title]);

  return container;
}

/**
 * Sizes a floating window to its content's height, so the window has no empty
 * margin around the surface. Full screen leaves it be.
 */
export function useFitFloatingWindow(container: HTMLElement | null) {
  React.useLayoutEffect(() => {
    const view = container?.ownerDocument.defaultView;
    const content = container?.firstElementChild;
    if (!container || !view || !content || view === window) return;
    const fit = () => {
      if (container.ownerDocument.fullscreenElement) return;
      const height = Math.ceil(content.getBoundingClientRect().height);
      if (height > 0 && height !== view.innerHeight) view.resizeTo(view.outerWidth, height);
    };
    const resize = new ResizeObserver(fit);
    resize.observe(content);
    fit();
    return () => resize.disconnect();
  }, [container]);
}

/**
 * Real full screen for `active`, on the display of the window that owns `doc`.
 * Leaving it from macOS (Escape, the green button) calls `onExit`.
 */
export function useScreenFullscreen(doc: Document | null, active: boolean, onExit: () => void) {
  const exit = React.useEffectEvent(onExit);
  React.useEffect(() => {
    if (!doc || !active || !canFloat()) return;
    const root = doc.documentElement;
    let entered = false;
    const change = () => {
      if (doc.fullscreenElement === root) entered = true;
      else if (entered) { entered = false; exit(); }
    };
    doc.addEventListener("fullscreenchange", change);
    if (!doc.fullscreenElement) void root.requestFullscreen?.().catch(() => undefined);
    return () => {
      doc.removeEventListener("fullscreenchange", change);
      if (doc.fullscreenElement === root) void doc.exitFullscreen().catch(() => undefined);
    };
  }, [doc, active]);
}
