import { useEffect } from "react";

/** How long a setting opened from search stays outlined. */
const FOUND_MS = 1600;
/** Rows that wait on loaded state get about a second to appear. */
const MAX_FRAMES = 60;

const ANCHOR_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isSettingAnchor(value: string | undefined): value is string {
  return value !== undefined && ANCHOR_PATTERN.test(value);
}

/**
 * Scrolls the setting named by `/settings/<tab>/<anchor>` into view, moves
 * focus to it and outlines it briefly, so someone who searched for one option
 * does not have to scan the page for it. `navigationKey` re-runs the reveal
 * when the same setting is opened again.
 */
export function useRevealSetting(anchor: string | undefined, navigationKey: string) {
  useEffect(() => {
    if (!isSettingAnchor(anchor)) return;
    let frame = 0;
    let frames = 0;
    let timer = 0;
    let found: HTMLElement | null = null;
    const reveal = () => {
      found = document.querySelector<HTMLElement>(`[data-setting-anchor="${anchor}"]`);
      if (!found) {
        frames += 1;
        if (frames < MAX_FRAMES) frame = requestAnimationFrame(reveal);
        return;
      }
      found.scrollIntoView({ block: "center" });
      found.focus({ preventScroll: true });
      found.setAttribute("data-setting-found", "");
      timer = window.setTimeout(() => found?.removeAttribute("data-setting-found"), FOUND_MS);
    };
    frame = requestAnimationFrame(reveal);
    return () => {
      cancelAnimationFrame(frame);
      window.clearTimeout(timer);
      found?.removeAttribute("data-setting-found");
    };
  }, [anchor, navigationKey]);
}
