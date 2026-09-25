import { useEffect } from "react";

/** The quiet stretch between two glints, and how long one sweep lasts. */
const MIN_GAP_MS = 7_000;
const MAX_GAP_MS = 18_000;
const SWEEP_MS = 1_600;

/**
 * Now and then, light crosses one glass surface (the team rail, a composer,
 * the floating title, a dialog) and passes behind what sits on it. One at a
 * time, at a random moment every several seconds, only on a surface on screen
 * (inside an open dialog when one is open), only while the window is in
 * front, and never with reduced motion. Surfaces opt in with `data-glint`;
 * this sets `data-glinting` for one sweep, and CSS draws it.
 */
export function useGlints(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(tick, MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
    };
    const tick = () => {
      if (!reduced.matches && !document.hidden && document.hasFocus()) {
        const dialog = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].pop();
        const candidates = [...(dialog ?? document).querySelectorAll<Element>("[data-glint]")].filter(onScreen);
        const target = candidates[Math.floor(Math.random() * candidates.length)];
        if (target) {
          target.setAttribute("data-glinting", "true");
          window.setTimeout(() => target.removeAttribute("data-glinting"), SWEEP_MS);
        }
      }
      schedule();
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [enabled]);
}

function onScreen(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}
