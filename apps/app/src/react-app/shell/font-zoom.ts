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

    const handleZoomShortcut = (event: KeyboardEvent) => {
      const action = parseFontZoomShortcut(event);
      if (!action) return;

      if (action === "in") {
        fontZoom = applyAndPersistFontZoom(fontZoom + FONT_ZOOM_STEP);
      } else if (action === "out") {
        fontZoom = applyAndPersistFontZoom(fontZoom - FONT_ZOOM_STEP);
      } else {
        fontZoom = applyAndPersistFontZoom(1);
      }

      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleZoomShortcut, true);
    return () => {
      window.removeEventListener("keydown", handleZoomShortcut, true);
    };
  }, []);
}
