import { useCallback, useLayoutEffect, useState } from "react";

/** iOS resizes/pans the visual viewport for its keyboard, not the 100dvh layout viewport. */
export function useWorkbotViewport(active = true) {
  // A dialog portal can mount after its owner's layout effect. Observe the actual node attachment, not just open.
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const viewport = useCallback((element: HTMLDivElement | null) => setNode(element), []);
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    if (!active || !node || !visual || !window.matchMedia("(pointer: coarse)").matches) return;
    let height = "";
    let top = "";
    const resize = () => {
      // Pinch zoom is a person's navigation, not a keyboard resize.
      if (visual.scale !== 1) return;
      // Set only when they change: iOS fires these while the person types, and an identical restyle still costs a
      // layout of the whole chat.
      const nextHeight = `${visual.height}px`;
      const nextTop = `${visual.offsetTop}px`;
      if (nextHeight !== height) node.style.setProperty("--wb-viewport-height", (height = nextHeight));
      if (nextTop !== top) node.style.setProperty("--wb-viewport-top", (top = nextTop));
    };
    resize();
    visual.addEventListener("resize", resize);
    visual.addEventListener("scroll", resize);
    return () => { visual.removeEventListener("resize", resize); visual.removeEventListener("scroll", resize); };
  }, [active, node]);
  return viewport;
}
