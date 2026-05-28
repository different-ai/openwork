import { isElectronRuntime } from "@/app/utils";

export function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__OPENWORK_ELECTRON__?.browser ?? null;
}

export function getNativeMenuPoint(
  el: HTMLElement | null,
  point?: { clientX: number; clientY: number },
) {
  const zoom = window.__OPENWORK_ZOOM_FACTOR__ ?? 1;

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
  const rect = el.getBoundingClientRect();
  const zoom = window.__OPENWORK_ZOOM_FACTOR__ ?? 1;

  return {
    x: Math.round(rect.x * zoom),
    y: Math.round(rect.y * zoom),
    width: Math.round(rect.width * zoom),
    height: Math.round(rect.height * zoom),
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
