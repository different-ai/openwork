import { useLayoutEffect, useRef } from "react";

/** iOS resizes/pans the visual viewport for its keyboard, not the 100dvh layout viewport. */
export function useWorkbotViewport(active = true) {
  const viewport = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!active) return;
    const node = viewport.current;
    const visual = window.visualViewport;
    if (!node || !visual || !window.matchMedia("(pointer: coarse)").matches) return;
    const resize = () => {
      // Pinch zoom is a person's navigation, not a keyboard resize.
      if (visual.scale !== 1) return;
      node.style.setProperty("--wb-viewport-height", `${visual.height}px`);
      node.style.setProperty("--wb-viewport-top", `${visual.offsetTop}px`);
    };
    resize();
    visual.addEventListener("resize", resize);
    visual.addEventListener("scroll", resize);
    return () => { visual.removeEventListener("resize", resize); visual.removeEventListener("scroll", resize); };
  }, [active]);
  return viewport;
}
