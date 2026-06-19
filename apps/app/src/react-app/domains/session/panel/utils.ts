import { isElectronRuntime } from "@/app/utils";

export function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__OPENWORK_ELECTRON__?.browser ?? null;
}

// Bounds and points are sent in renderer CSS pixels. The Electron main process
// converts them to window device-independent pixels using the authoritative
// webContents zoom factor at apply time, so the renderer never needs to track
// (and can never disagree with) the real zoom state.
export function getNativeMenuPoint(
  el: HTMLElement | null,
  point?: { clientX: number; clientY: number },
) {
  if (point) {
    return { x: point.clientX, y: point.clientY };
  }

  if (!el) {
    return undefined;
  }

  const rect = el.getBoundingClientRect();

  return {
    x: rect.left + 8,
    y: rect.bottom + 4,
  };
}

export function computeBounds(el: HTMLElement) {
  const rect = el.getBoundingClientRect();

  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
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
