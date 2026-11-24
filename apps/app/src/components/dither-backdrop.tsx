import { Dithering } from "@paper-design/shaders-react";

let webGl2Available: boolean | null = null;

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

export function DitherBackdrop() {
  if (!supportsWebGl2()) return null;
  return (
    <Dithering
      className="size-full"
      speed={0}
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
