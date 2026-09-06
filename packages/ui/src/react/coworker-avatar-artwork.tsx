import type { Ref } from "react";
import type { AvatarMotion } from "./coworker-avatar-motion";

export type AvatarColor = "blue" | "violet" | "mint" | "orange" | "rose" | "slate" | "sand" | "sage";
export type AvatarGlasses = "round" | "square" | "oval" | "none" | "sunglasses" | "monocle";

const PALETTES: Record<AvatarColor, { fill: string; edge: string; depth: string }> = {
  blue: { fill: "#b8c9f0", edge: "#91a9dc", depth: "#7389b7" },
  violet: { fill: "#c8c1e2", edge: "#aaa1d0", depth: "#81789f" },
  mint: { fill: "#b2d5cb", edge: "#8dbbae", depth: "#668e84" },
  orange: { fill: "#e4c3ad", edge: "#cda589", depth: "#9d7961" },
  rose: { fill: "#e2c1cb", edge: "#cda1ae", depth: "#9c7682" },
  slate: { fill: "#e3e6ea", edge: "#c2c8d0", depth: "#939aa4" },
  sand: { fill: "#ded0b0", edge: "#c1ae86", depth: "#95825c" },
  sage: { fill: "#becab4", edge: "#9eaf91", depth: "#788b6c" },
};

export type StaticCoworkerAvatarProps = {
  name: string;
  color: AvatarColor;
  glasses: AvatarGlasses;
  size?: number;
  animated?: boolean;
  working?: boolean;
  identity?: string;
  motion?: AvatarMotion;
  svgRef?: Ref<SVGSVGElement>;
};

/** Hook-free SVG shared by the animated client and server image renderer. */
export function StaticCoworkerAvatar({
  name,
  color,
  glasses,
  size = 96,
  animated = false,
  working = false,
  svgRef,
  identity = name,
  motion = size <= 44 ? "quiet" : "attentive",
}: StaticCoworkerAvatarProps) {
  const palette = PALETTES[color];

  return (
    <svg
      ref={svgRef}
      aria-label={`${name || "Coworker"} avatar`}
      className={`coworker-avatar ${working ? "is-working" : ""}`}
      data-identity={identity}
      data-testid="coworker-avatar"
      data-motion={motion}
      data-context={size <= 44 ? "compact" : "prominent"}
      data-animated={animated}
      data-motion-paused="true"
      data-reaction="none"
      data-glasses={glasses}
      role="img"
      style={{ width: size, height: size }}
      width={size}
      height={size}
      viewBox="0 0 122 122"
    >
      <g className="coworker-avatar__pointer-body">
        <g className="coworker-avatar__body">
          <g className="coworker-avatar__depth">
            <path
              d="M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z"
              fill={palette.depth}
              opacity="0.72"
              transform="translate(3 3)"
            />
          </g>
          <path
            d="M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z"
            fill={palette.fill}
            stroke={palette.edge}
            strokeWidth="1.25"
          />
          <path
            d="M26 11h64c12 0 20 7 21 19"
            fill="none"
            stroke="#ffffff"
            strokeLinecap="round"
            strokeOpacity="0.24"
            strokeWidth="1"
          />
          <g className="coworker-avatar__pointer-features">
            <g className="coworker-avatar__features">
              <g className="coworker-avatar__pointer-gaze">
                <g className="coworker-avatar__gaze">
                  <g className="coworker-avatar__pupils" fill="#0b0e14">
                    <rect x="34.5" y="50" width="6" height="14" rx="3" />
                    <rect x="79.5" y="50" width="6" height="14" rx="3" />
                  </g>
                </g>
              </g>
              {glasses === "round" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="5">
                  <circle cx="37.5" cy="57" r="17.5" />
                  <circle cx="82.5" cy="57" r="17.5" />
                  <path d="M57.5 57c1.25-4 3.75-4 5 0" />
                  <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
                </g>
              ) : null}
              {glasses === "oval" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="5">
                  <ellipse cx="37.5" cy="57" rx="18" ry="14" />
                  <ellipse cx="82.5" cy="57" rx="18" ry="14" />
                  <path d="M57.5 57c1.25-4 3.75-4 5 0" />
                  <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
                </g>
              ) : null}
              {glasses === "square" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5">
                  <rect x="19.5" y="39" width="36" height="36" rx="10" />
                  <rect x="64.5" y="39" width="36" height="36" rx="10" />
                  <path d="M58 57c1-3.5 3-3.5 4 0" />
                  <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
                </g>
              ) : null}
              {glasses === "sunglasses" ? (
                <g className="coworker-avatar__glasses" stroke="#11151d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="4.5">
                  <rect x="19.5" y="41" width="36" height="32" rx="12" fill="#263349" fillOpacity="0.24" />
                  <rect x="64.5" y="41" width="36" height="32" rx="12" fill="#263349" fillOpacity="0.24" />
                  <path d="M57.5 55c1.25-2.5 3.75-2.5 5 0M15 55h4.5M100.5 55h4.5" fill="none" />
                  <path d="M27 47h12M72 47h12" stroke="#ffffff" strokeOpacity="0.25" strokeWidth="1.5" />
                </g>
              ) : null}
              {glasses === "monocle" ? (
                <g className="coworker-avatar__glasses" fill="none" stroke="#11151d" strokeLinecap="round">
                  <circle cx="82.5" cy="57" r="17.5" strokeWidth="3.5" />
                  <path d="M96 68l2 2" strokeWidth="2.5" />
                  {size > 36 ? <path className="coworker-avatar__monocle-chain" d="M98 70c5 6 6 16 0 20-3 2-5 1-5-2" strokeWidth="1.25" strokeOpacity="0.7" /> : null}
                </g>
              ) : null}
            </g>
          </g>
        </g>
      </g>
    </svg>
  );
}
