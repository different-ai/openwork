import { isElectronRuntime } from "@/app/utils";

export function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__OPENWORK_ELECTRON__?.browser ?? null;
}

// The renderer uses Electron's webContents.setZoomFactor, which scales the page
// so getBoundingClientRect() / innerWidth report CSS pixels DIVIDED by the zoom
// factor (e.g. at zoom 1.5 a 1180 DIP window measures ~786). WebContentsView
// bounds, however, are in window device-independent pixels. So renderer rects
// must be multiplied back by the zoom factor to land in the native coordinate
// space. At zoom = 1 this is the identity.
function getZoomFactor() {
  const zoom = window.__OPENWORK_ZOOM_FACTOR__;
  return typeof zoom === "number" && zoom > 0 ? zoom : 1;
}

export function getNativeMenuPoint(
  el: HTMLElement | null,
  point?: { clientX: number; clientY: number },
) {
  const zoom = getZoomFactor();

  if (point) {
    return {
      x: Math.round(point.clientX * zoom),
      y: Math.round(point.clientY * zoom),
    };
  }

  if (!el) {
    return undefined;
  }

  const rect = el.getBoundingClientRect();

  return {
    x: Math.round((rect.left + 8) * zoom),
    y: Math.round((rect.bottom + 4) * zoom),
  };
}

export function computeBounds(el: HTMLElement) {
  // Scale each edge to native DIP, then derive width/height from the rounded
  // edges so the far edge has no sub-pixel seam at any zoom level.
  const rect = el.getBoundingClientRect();
  const zoom = getZoomFactor();
  const x = Math.round(rect.x * zoom);
  const y = Math.round(rect.y * zoom);

  return {
    x,
    y,
    width: Math.round(rect.right * zoom) - x,
    height: Math.round(rect.bottom * zoom) - y,
  };
}

export function sameBounds(
  left: { x: number; y: number; width: number; height: number } | null,
  right: { x: number; y: number; width: number; height: number },
) {
  return Boolean(
    left &&
      left.x === right.x &&
      left.y === right.y &&
      left.width === right.width &&
      left.height === right.height,
  );
}

export function hasNativeBrowserOccluder() {
  const overlays = document.querySelectorAll('[role="dialog"], [role="alertdialog"]');
  for (const overlay of overlays) {
    if (!(overlay instanceof HTMLElement)) {
      continue;
    }

    if (overlay.offsetParent !== null || overlay.getClientRects().length > 0) {
      return true;
    }
  }
  return false;
}
