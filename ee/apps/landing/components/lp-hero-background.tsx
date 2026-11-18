"use client";

import { Dithering } from "@paper-design/shaders-react";
import { useEffect, useState } from "react";

// The mask lives in globals.css (.lp-hero-dither) so it can change per breakpoint.
function canCreateWebGlContext(): boolean {
  if (typeof document === "undefined") return false;
  const canvas = document.createElement("canvas");
  return Boolean(
    canvas.getContext("webgl") || canvas.getContext("experimental-webgl")
  );
}

export function LpHeroBackground() {
  const [supported, setSupported] = useState(false);

  useEffect(() => {
    setSupported(canCreateWebGlContext());
  }, []);

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[1200px] overflow-hidden bg-[#fcfcfc]"
    >
      {supported ? (
        <div className="lp-hero-dither absolute inset-0">
          <Dithering
            speed={0}
            shape="warp"
            type="4x4"
            size={2.5}
            scale={1}
            frame={30214.2}
            colorBack="#fcfcfc"
            colorFront="#171717"
            style={{ width: "100%", height: "100%" }}
          />
        </div>
      ) : null}
    </div>
  );
}
