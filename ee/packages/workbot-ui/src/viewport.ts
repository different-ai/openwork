import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Where the element is positioned from: `fixed` elements (a drawer) measure from the layout viewport (offsetTop);
 * the page's own shell is `absolute` in the document (pageTop), so it follows the document if iOS scrolls it for the
 * keyboard. The shell is not `position: fixed` on purpose: Safari 26 on iPhone paints a solid bar, in the colour of a
 * fixed element's edge, behind its status bar and floating toolbar (styles.css, `.workbot-viewport`).
 */
type WorkbotViewportPosition = "fixed" | "absolute";

/** iOS resizes/pans the visual viewport for its keyboard, not the 100dvh layout viewport. */
export function useWorkbotViewport(active = true, position: WorkbotViewportPosition = "fixed") {
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
      const nextTop = `${position === "absolute" ? visual.pageTop : visual.offsetTop}px`;
      if (nextHeight !== height) node.style.setProperty("--wb-viewport-height", (height = nextHeight));
      if (nextTop !== top) node.style.setProperty("--wb-viewport-top", (top = nextTop));
      // The keyboard covers the home indicator: the message box then sits on the keyboard, without the safe area.
      node.toggleAttribute("data-workbot-keyboard", window.innerHeight - visual.height > 120);
    };
    resize();
    visual.addEventListener("resize", resize);
    visual.addEventListener("scroll", resize);
    // A document scroll (iOS bringing a focused field into view) moves pageTop without a visual viewport scroll.
    if (position === "absolute") window.addEventListener("scroll", resize, { passive: true });
    return () => {
      visual.removeEventListener("resize", resize);
      visual.removeEventListener("scroll", resize);
      window.removeEventListener("scroll", resize);
      node.removeAttribute("data-workbot-keyboard");
    };
  }, [active, node, position]);
  return viewport;
}
