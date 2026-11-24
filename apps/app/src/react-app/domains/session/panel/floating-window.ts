import * as React from "react";

import { isElectronRuntime } from "@/app/lib/runtime-env";

const FLOATING_VIEW_PREFIX = "openwork-floating-";
const EDGE = 16;
const CASCADE = 32;

function canFloat() {
  return isElectronRuntime() && /\bElectron\//.test(navigator.userAgent);
}

type FloatingWindowOptions = {
  title: string;
  width: number;
  height: number;
  onClosed: () => void;
};

type WindowPlacement = { left: number; top: number; width: number; height: number };

const placements = new Map<string, WindowPlacement>();

function firstPlacement(width: number, height: number): WindowPlacement {
  return {
    left: Math.round(window.screenX + CASCADE),
    top: Math.round(window.screenY + CASCADE),
    width: Math.min(width, window.screen.availWidth - EDGE * 2),
    height: Math.min(height, window.screen.availHeight - EDGE * 2),
  };
}

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
  };
  copyStyles();
  copyRoot();
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

export function useFloatingWindow(name: string, open: boolean, { title, width, height, onClosed }: FloatingWindowOptions): HTMLElement | null {
  const [container, setContainer] = React.useState<HTMLElement | null>(null);
  const closed = React.useEffectEvent(onClosed);
  const size = React.useRef({ width, height, title });
  size.current = { width, height, title };

  React.useLayoutEffect(() => {
    if (!open) return;
    const { width: firstWidth, height: firstHeight, title: initialTitle } = size.current;
    const { left, top, width: w, height: h } = placements.get(name) ?? firstPlacement(firstWidth, firstHeight);
    const popup = canFloat()
      ? window.open("about:blank", `${FLOATING_VIEW_PREFIX}${name}`, `popup,width=${w},height=${h},left=${left},top=${top}`)
      : null;
    if (!popup) {
      closed();
      return;
    }
    const doc = popup.document;
    doc.title = initialTitle;
    Object.assign(doc.body.style, { margin: "0", overflow: "hidden" });
    const root = doc.createElement("div");
    root.dataset.floatingWindow = name;
    doc.body.appendChild(root);
    const stopMirror = mirrorDocument(document, doc);
    setContainer(root);
    let disposed = false;
    const watch = window.setInterval(() => {
      if (disposed) return;
      if (!popup.closed) {
        placements.set(name, { left: popup.screenX, top: popup.screenY, width: popup.outerWidth, height: popup.outerHeight });
        return;
      }
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
