import { useLayoutEffect, type RefObject } from "react";

/** How tall a composer may grow before it scrolls instead (about six lines). */
export const COMPOSER_MAX_HEIGHT_PX = 160;

/**
 * Keep a textarea exactly as tall as its content, up to a cap. A new line
 * (Shift Enter) or a long paste grows the field; clearing it shrinks it back.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, maxPx = COMPOSER_MAX_HEIGHT_PX): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.style.height = "0px";
    const next = Math.min(element.scrollHeight, maxPx);
    element.style.height = `${next}px`;
    element.style.overflowY = element.scrollHeight > maxPx ? "auto" : "hidden";
  }, [maxPx, ref, value]);
}
