import { useEffect } from "react";

/**
 * When the light passes, measured from launch: every 30 seconds in the first
 * minute, then every minute for a few minutes, then every two minutes.
 */
const GAPS_MS = [30_000, 30_000, 60_000, 60_000, 60_000];
const LATER_GAP_MS = 120_000;
/** How fast the light crosses the window, and how wide its band is. */
const PX_PER_MS = 1.2;
const BAND_PX = 240;

/**
 * Now and then, one faint light passes through the app: it crosses every glass
 * surface on screen at once (the team rail, the composer, the floating title,
 * a dialog), left to right at one speed, behind what sits on them. Only while
 * the window is in front, only over an open dialog when there is one, and
 * never with reduced motion. Surfaces opt in with `data-glint`; this times
 * each surface's part of the sweep, and CSS draws it.
 */
export function useGlints(enabled = true): void {
  useEffect(() => {
    if (!enabled) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    let sweeps = 0;
    let timer = 0;
    const schedule = () => {
      timer = window.setTimeout(sweep, GAPS_MS[sweeps] ?? LATER_GAP_MS);
    };
    const sweep = () => {
      sweeps += 1;
      if (!reduced.matches && !document.hidden && document.hasFocus()) {
        const dialog = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].pop();
        const surfaces = [...(dialog ?? document).querySelectorAll<HTMLElement>("[data-glint]")];
        let last = 0;
        for (const surface of surfaces) {
          const rect = surface.getBoundingClientRect();
          if (!onScreen(rect)) continue;
          // Each surface shows its stretch of one band crossing the window: it enters
          // when the band reaches the surface's left edge and leaves past its right.
          const delay = rect.left / PX_PER_MS;
          const duration = (rect.width + BAND_PX) / PX_PER_MS;
          surface.style.setProperty("--sheen-band", `${BAND_PX}px`);
          surface.style.setProperty("--sheen-end", `${Math.round(rect.width)}px`);
          surface.style.setProperty("--sheen-delay", `${Math.round(delay)}ms`);
          surface.style.setProperty("--sheen-duration", `${Math.round(duration)}ms`);
          surface.setAttribute("data-glinting", "true");
          last = Math.max(last, delay + duration);
        }
        window.setTimeout(() => {
          for (const surface of surfaces) surface.removeAttribute("data-glinting");
        }, last + 100);
      }
      schedule();
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [enabled]);
}

function onScreen(rect: DOMRect): boolean {
  return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth;
}
