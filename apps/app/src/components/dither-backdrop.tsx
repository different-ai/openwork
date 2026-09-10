import { Dithering } from "@paper-design/shaders-react";

let webGl2Available: boolean | null = null;

/**
 * Paper Shaders mounts on a WebGL2 canvas and throws (as an unhandled
 * rejection) when the GPU offers none: headless CI, some VDI desktops,
 * GPU-disabled policies. The check is cached; GPU availability does not
 * change within a session.
 */
function supportsWebGl2(): boolean {
  if (webGl2Available !== null) return webGl2Available;
  try {
    webGl2Available = typeof document !== "undefined"
      && document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    webGl2Available = false;
  }
  return webGl2Available;
}

/**
 * Paper first-load spec: subtle pixel-dither mosaic over the page ground.
 * Renders nothing without WebGL2, leaving the plain page background.
 */
export function DitherBackdrop() {
  if (!supportsWebGl2()) return null;
  return (
    <Dithering
      className="size-full"
      speed={0.01}
      shape="warp"
      type="2x2"
      size={20.3}
      scale={1.19}
      frame={264559.21}
      colorBack="#00000000"
      colorFront="#000000"
    />
  );
}
