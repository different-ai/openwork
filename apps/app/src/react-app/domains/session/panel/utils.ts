import { isElectronRuntime } from "@/app/utils";

export function getElectronBrowser() {
  if (!isElectronRuntime()) {
    return null;
  }

  return window.__OPENWORK_ELECTRON__?.browser ?? null;
}

// Bounds and menu points use CSS pixels. Preload stamps the browser bounds with
// measurement zoom; native menus handle their own coordinate conversion.
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
