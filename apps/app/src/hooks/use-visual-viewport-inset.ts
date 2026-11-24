import { useEffect } from "react";

export function visualViewportGeometry(height: number, offsetTop: number, scale: number) {
  if (scale !== 1 || !Number.isFinite(height) || !Number.isFinite(offsetTop) || height <= 0) return null;
  return { height: Math.round(height), top: Math.max(0, Math.round(offsetTop)) };
}

export function useVisualViewportInset() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const sync = () => {
      const geometry = visualViewportGeometry(viewport.height, viewport.offsetTop, viewport.scale);
      if (!geometry) return;
      document.documentElement.style.setProperty("--chat-viewport-height", `${geometry.height}px`);
      document.documentElement.style.setProperty("--chat-viewport-top", `${geometry.top}px`);
    };

    sync();
    viewport.addEventListener("resize", sync);
    viewport.addEventListener("scroll", sync);
    window.addEventListener("orientationchange", sync);
    window.addEventListener("resize", sync);
    return () => {
      viewport.removeEventListener("resize", sync);
      viewport.removeEventListener("scroll", sync);
      window.removeEventListener("orientationchange", sync);
      window.removeEventListener("resize", sync);
      document.documentElement.style.removeProperty("--chat-viewport-height");
      document.documentElement.style.removeProperty("--chat-viewport-top");
    };
  }, []);
}
