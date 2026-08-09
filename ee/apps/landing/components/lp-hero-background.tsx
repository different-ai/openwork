"use client";

import { PaperGrainGradient } from "@openwork/ui/react";

export function LpHeroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[980px] overflow-hidden"
    >
      <div className="absolute inset-0 opacity-50">
        <PaperGrainGradient
          colors={["#f6f9fc", "#f6f9fc", "#1e293b", "#334155"]}
          colorBack="#f6f9fc"
          softness={1}
          intensity={0.03}
          noise={0.14}
          shape="corners"
          speed={0.2}
          style={{ width: "100%", height: "100%" }}
        />
      </div>
      <div className="absolute inset-x-0 bottom-0 h-[320px] bg-gradient-to-b from-transparent to-[var(--lp-page)]" />
    </div>
  );
}
