/** @jsxImportSource react */
import { useEffect } from "react";

import {
  FONT_ZOOM_STEP,
  applyFontZoom,
  normalizeFontZoom,
  parseFontZoomShortcut,
  persistFontZoom,
  readStoredFontZoom,
} from "../../app/lib/font-zoom";
import { setDesktopZoomFactor } from "../../app/lib/desktop";
import { isDesktopRuntime } from "../../app/utils";

const NATIVE_MENU_ZOOM_EVENT = "openwork:native-menu:zoom";

export function useDesktopFontZoomBehavior() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!isDesktopRuntime()) return;

    const applyAndPersistFontZoom = (value: number) => {
      const next = normalizeFontZoom(value);
      persistFontZoom(window.localStorage, next);

      void setDesktopZoomFactor(next)
        .then((applied) => {
          if (applied) {
            document.documentElement.style.removeProperty("--openwork-font-size");
            return;
          }
          applyFontZoom(document.documentElement.style, next);
        })
        .catch(() => {
          applyFontZoom(document.documentElement.style, next);
        });

      return next;
    };

    let fontZoom = applyAndPersistFontZoom(readStoredFontZoom(window.localStorage) ?? 1);

    const applyZoomAction = (action: "in" | "out" | "reset") => {
      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }
    };

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseFontZoomShortcut(event);
      if (!action) return;

      applyZoomAction(action);

      event.preventDefault();
      event.stopPropagation();
    };

    // Native menu zoom items (View > Zoom In/Out/Actual Size) route through the
    // same pathway so app zoom always stays consistent and persisted.
    const handleNativeMenuZoom = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : null;
      if (detail === "in" || detail === "out" || detail === "reset") {
        applyZoomAction(detail);
      }
    };

    window.addEventListener("keydown", handleZoomShortcut, true);
    window.addEventListener(NATIVE_MENU_ZOOM_EVENT, handleNativeMenuZoom);
    return () => {
      window.removeEventListener("keydown", handleZoomShortcut, true);
      window.removeEventListener(NATIVE_MENU_ZOOM_EVENT, handleNativeMenuZoom);
    };
  }, []);
}
