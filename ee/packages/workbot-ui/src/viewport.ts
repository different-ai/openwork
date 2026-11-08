import { useCallback, useLayoutEffect, useState } from "react";

/** iOS resizes/pans the visual viewport for its keyboard, not the 100dvh layout viewport. */
export function useWorkbotViewport(active = true) {
  // A dialog portal can mount after its owner's layout effect. Observe the actual node attachment, not just open.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const viewport = useCallback((element: HTMLDivElement | null) => setNode(element), []);
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    if (!active || !node || !visual || !window.matchMedia("(pointer: coarse)").matches) return;
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
  }, [active, node]);
  return viewport;
}
