"use client";

import { PaperGrainGradient } from "@openwork/ui/react";

export function LandingBackground({ fadeOnScroll = true }: { fadeOnScroll?: boolean }) {
  return (
    <>
      <div
        className={`${fadeOnScroll ? "landing-background-fade" : "opacity-60"} pointer-events-none fixed inset-0 z-0`}
      >
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

      <style jsx>{`
        .landing-background-fade {
          opacity: 0.6;
          will-change: opacity;
        }

        @supports (animation-timeline: scroll(root block)) {
          .landing-background-fade {
            animation-name: landing-background-fade-out;
            animation-duration: 1s;
            animation-timing-function: linear;
            animation-fill-mode: both;
            animation-timeline: scroll(root block);
            animation-range: 0px 500px;
          }
        }

        @keyframes landing-background-fade-out {
          from {
            opacity: 0.6;
          }

          to {
            opacity: 0;
          }
        }
      `}</style>
    </>
  );
}
