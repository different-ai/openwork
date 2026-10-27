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

type BrowserOccluderBounds = { x: number; y: number; width: number; height: number };

function isShownOverlay(overlay: Element): overlay is HTMLElement {
  return overlay instanceof HTMLElement && overlay.getAttribute("aria-hidden") !== "true" && overlay.getClientRects().length > 0;
}

function overlapsBounds(overlay: HTMLElement, bounds: BrowserOccluderBounds | null) {
  if (!bounds) return false;
  const rect = overlay.getBoundingClientRect();
  return rect.right > bounds.x && rect.left < bounds.x + bounds.width
    && rect.bottom > bounds.y && rect.top < bounds.y + bounds.height;
}

/**
 * Whether app UI must sit above the native browser page, which always paints
 * over the renderer. Without options this is the original check: any shown
 * `role="dialog"`/`alertdialog`. With options (floating browser presentation)
 * it also covers open `<dialog>` elements anywhere, and menus, listboxes and
 * tooltips that overlap the page, but never `exclude`, the browser's own
 * full-screen dialog.
 */
export function hasNativeBrowserOccluder(options?: { bounds: BrowserOccluderBounds | null; exclude?: Element | null }) {
  if (options) {
    for (const overlay of document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')) {
      if (overlay !== options.exclude && isShownOverlay(overlay)) return true;
    }
    for (const overlay of document.querySelectorAll('[role="menu"], [role="listbox"], [role="tooltip"]')) {
      if (isShownOverlay(overlay) && !options.exclude?.contains(overlay) && overlapsBounds(overlay, options.bounds)) return true;
    }
    return false;
  }
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
