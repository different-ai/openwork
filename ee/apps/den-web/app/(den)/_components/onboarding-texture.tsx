"use client";

import { Dithering } from "@paper-design/shaders-react";
import { useWebGlSupported } from "../_lib/use-webgl-supported";

export function OnboardingTexture() {
  const supported = useWebGlSupported();
  return <div aria-hidden="true" data-testid="auth-landing-visual" className="pointer-events-none h-full w-full bg-[#171717]">
    {supported ? <Dithering
      speed={0}
      shape="warp"
      type="4x4"
      size={2.5}
      scale={1}
      frame={30214.2}
      colorBack="#171717"
      colorFront="#FEFEFE"
      style={{ width: "100%", height: "100%" }}
    /> : null}
  </div>;
}

