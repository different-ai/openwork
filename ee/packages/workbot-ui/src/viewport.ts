import { useCallback, useLayoutEffect, useState } from "react";

type WorkbotViewportPosition = "fixed" | "absolute";

/**
 * iOS resizes/pans the visual viewport for its keyboard, not the 100dvh layout viewport. Android resizes the page
 * itself (the host page's `interactive-widget=resizes-content`), so there both agree and this only confirms them.
 */
export function useWorkbotViewport(active = true, position: WorkbotViewportPosition = "fixed") {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const viewport = useCallback((element: HTMLDivElement | null) => setNode(element), []);
  useLayoutEffect(() => {
    const visual = window.visualViewport;
    if (!active || !node || !visual || !window.matchMedia("(pointer: coarse)").matches) return;
    let height = "";
    let top = "";
    const resize = () => {
      if (visual.scale !== 1) return;
      const nextHeight = `${visual.height}px`;
      const nextTop = `${position === "absolute" ? visual.pageTop : visual.offsetTop}px`;
      if (nextHeight !== height) node.style.setProperty("--wb-viewport-height", (height = nextHeight));
      if (nextTop !== top) node.style.setProperty("--wb-viewport-top", (top = nextTop));
      node.toggleAttribute("data-workbot-keyboard", window.innerHeight - visual.height > 120);
    };
    resize();
    visual.addEventListener("resize", resize);
    visual.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    if (position === "absolute") window.addEventListener("scroll", resize, { passive: true });
    return () => {
      visual.removeEventListener("resize", resize);
      visual.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
      window.removeEventListener("scroll", resize);
      node.removeAttribute("data-workbot-keyboard");
    };
  }, [active, node, position]);
  return viewport;
}
