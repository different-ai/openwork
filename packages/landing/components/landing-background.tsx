"use client";

export function LandingBackground() {
  return (
    <>
      {/* <div className="pointer-events-none fixed inset-0 z-0 bg-[#f6f9fc]" /> */}

      {/*
        Top landing paper-grain background is intentionally disabled for now.
        Keep this block for quick reactivation later.

        <div className="landing-background-fade pointer-events-none fixed inset-0 z-0">
          <ResponsiveGrain
            colors={["#f6f9fc", "#f6f9fc", "#1e293b", "#334155"]}
            colorBack="#f6f9fc"
            softness={1}
            intensity={0.03}
            noise={0.14}
            shape="corners"
            speed={0.2}
          />
        </div>
      */}

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
