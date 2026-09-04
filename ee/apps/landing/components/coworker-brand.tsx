/**
 * Open Coworker's brand mark and coworker avatar, drawn for the site from the
 * same geometry and palettes as the app (`apps/coworker/src/ui/brand.tsx`,
 * `coworker-avatar.tsx`) — static here, without the app's pointer gaze, so the
 * landing (React 18, Tailwind 3) does not import from the app (React 19,
 * Tailwind 4). Change the app first, then mirror it here.
 */

const BUBBLE_PATH =
  "M26 8h65c15 0 23 10 23 26v46c0 15-8 24-23 24H57l-15 9c-5 3-10 0-10-6v-3h-5C12 104 5 95 5 80V34C5 18 12 8 26 8Z";

export type AvatarColor = "blue" | "violet" | "mint" | "orange" | "rose" | "slate";
export type AvatarGlasses = "round" | "square" | "none";

const PALETTES: Record<AvatarColor, { fill: string; edge: string; depth: string }> = {
  blue: { fill: "#b8c9f0", edge: "#91a9dc", depth: "#7389b7" },
  violet: { fill: "#c8c1e2", edge: "#aaa1d0", depth: "#81789f" },
  mint: { fill: "#b2d5cb", edge: "#8dbbae", depth: "#668e84" },
  orange: { fill: "#e4c3ad", edge: "#cda589", depth: "#9d7961" },
  rose: { fill: "#e2c1cb", edge: "#cda1ae", depth: "#9c7682" },
  slate: { fill: "#e3e6ea", edge: "#c2c8d0", depth: "#939aa4" },
};

/** The app icon: a white speech bubble with round glasses on a light tile. */
export function CoworkerMark({ size = 44, label, tile = true, className = "" }: { size?: number; label?: string; tile?: boolean; className?: string }) {
  return (
    <svg
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      className={className}
      style={{ width: size, height: size }}
      viewBox="0 0 122 122"
    >
      {tile ? <rect x="3" y="3" width="116" height="116" rx="29" fill="#f7f8fa" /> : null}
      {tile ? <rect x="3.5" y="3.5" width="115" height="115" rx="28.5" fill="none" stroke="#d8dde5" /> : null}
      <g transform={tile ? "translate(14.7 14.5) scale(0.76)" : "translate(1 2)"}>
        {tile ? <path d={BUBBLE_PATH} fill="#d9dde4" stroke="#aeb5c0" strokeLinejoin="round" strokeWidth="2.4" transform="translate(5.2 2.8)" /> : null}
        <path d={BUBBLE_PATH} fill="#f7f8fa" />
        <path d={BUBBLE_PATH} fill="none" stroke="#11151d" strokeLinejoin="round" strokeWidth="3.4" />
        <g fill="#0b0e14">
          <rect x="34.5" y="50" width="6" height="14" rx="3" />
          <rect x="79.5" y="50" width="6" height="14" rx="3" />
        </g>
        <g fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="4.6">
          <circle cx="37.5" cy="57" r="17.5" />
          <circle cx="82.5" cy="57" r="17.5" />
          <path d="M57.5 57c1.25-4 3.75-4 5 0" />
          <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
        </g>
      </g>
    </svg>
  );
}

/** One coworker: a tinted speech bubble with its own glasses. */
export function CoworkerAvatar({ name, color, glasses, size = 40 }: { name: string; color: AvatarColor; glasses: AvatarGlasses; size?: number }) {
  const palette = PALETTES[color];
  return (
    <svg aria-label={`${name} avatar`} role="img" style={{ width: size, height: size }} viewBox="0 0 122 122">
      <path d={BUBBLE_PATH} fill={palette.depth} opacity="0.72" transform="translate(3 3)" />
      <path d={BUBBLE_PATH} fill={palette.fill} stroke={palette.edge} strokeWidth="1.25" />
      <path d="M26 11h64c12 0 20 7 21 19" fill="none" stroke="#ffffff" strokeLinecap="round" strokeOpacity="0.24" strokeWidth="1" />
      <g fill="#0b0e14">
        <rect x="34.5" y="50" width="6" height="14" rx="3" />
        <rect x="79.5" y="50" width="6" height="14" rx="3" />
      </g>
      {glasses === "round" ? (
        <g fill="none" stroke="#11151d" strokeLinecap="round" strokeWidth="5">
          <circle cx="37.5" cy="57" r="17.5" />
          <circle cx="82.5" cy="57" r="17.5" />
          <path d="M57.5 57c1.25-4 3.75-4 5 0" />
          <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
        </g>
      ) : null}
      {glasses === "square" ? (
        <g fill="none" stroke="#11151d" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5">
          <rect x="19.5" y="39" width="36" height="36" rx="10" />
          <rect x="64.5" y="39" width="36" height="36" rx="10" />
          <path d="M58 57c1-3.5 3-3.5 4 0" />
          <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
        </g>
      ) : null}
    </svg>
  );
}
