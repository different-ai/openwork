import type { AvatarColor, AvatarGlasses } from "@/lib/bridge";
import { useAvatarPointerGaze } from "@/ui/use-avatar-pointer-gaze";

const AVATAR_COLORS: Array<{ id: AvatarColor; label: string; swatch: string }> = [
  { id: "blue", label: "OpenWork blue", swatch: "#b8c9f0" },
  { id: "violet", label: "Violet", swatch: "#c8c1e2" },
  { id: "mint", label: "Mint", swatch: "#b2d5cb" },
  { id: "orange", label: "Orange", swatch: "#e4c3ad" },
  { id: "rose", label: "Rose", swatch: "#e2c1cb" },
  { id: "slate", label: "Pearl", swatch: "#e3e6ea" },
];

const AVATAR_GLASSES: Array<{ id: AvatarGlasses; label: string }> = [
  { id: "round", label: "Round" },
  { id: "square", label: "Soft square" },
  { id: "none", label: "None" },
];

const PALETTES: Record<AvatarColor, { fill: string; edge: string; depth: string }> = {
  blue: { fill: "#b8c9f0", edge: "#91a9dc", depth: "#7389b7" },
  violet: { fill: "#c8c1e2", edge: "#aaa1d0", depth: "#81789f" },
  mint: { fill: "#b2d5cb", edge: "#8dbbae", depth: "#668e84" },
  orange: { fill: "#e4c3ad", edge: "#cda589", depth: "#9d7961" },
  rose: { fill: "#e2c1cb", edge: "#cda1ae", depth: "#9c7682" },
  slate: { fill: "#e3e6ea", edge: "#c2c8d0", depth: "#939aa4" },
};

function motionPhase(name: string) {
  const value = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return value % 3;
}

export function CoworkerAvatar({
  name,
  color,
  glasses,
  size = 96,
  animated = true,
  working = false,
}: {
  name: string;
  color: AvatarColor;
  glasses: AvatarGlasses;
  size?: number;
  animated?: boolean;
  working?: boolean;
}) {
  const palette = PALETTES[color];
  const phase = motionPhase(name);
  const motionClass = animated ? `is-animated motion-phase-${phase}` : "";
  const avatarRef = useAvatarPointerGaze();

  return (
    <svg
      ref={avatarRef}
      aria-label={`${name || "Coworker"} avatar`}
      className={`coworker-avatar ${motionClass} ${working ? "is-working" : ""}`}
      role="img"
      style={{ width: size, height: size }}
      viewBox="0 0 122 122"
    >
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
            <g
              className="coworker-avatar__glasses"
              fill="none"
              stroke="#11151d"
              strokeLinecap="round"
              strokeWidth="5"
            >
              <circle cx="37.5" cy="57" r="17.5" />
              <circle cx="82.5" cy="57" r="17.5" />
              <path d="M57.5 57c1.25-4 3.75-4 5 0" />
              <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
            </g>
          ) : null}
          {glasses === "square" ? (
            <g
              className="coworker-avatar__glasses"
              fill="none"
              stroke="#11151d"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="5"
            >
              <rect x="19.5" y="39" width="36" height="36" rx="10" />
              <rect x="64.5" y="39" width="36" height="36" rx="10" />
              <path d="M58 57c1-3.5 3-3.5 4 0" />
              <path d="M15 57h4.5M100.5 57h4.5" strokeWidth="7" />
            </g>
          ) : null}
        </g>
      </g>
    </svg>
  );
}

export function AvatarControls({
  color,
  glasses,
  onColorChange,
  onGlassesChange,
}: {
  color: AvatarColor;
  glasses: AvatarGlasses;
  onColorChange: (color: AvatarColor) => void;
  onGlassesChange: (glasses: AvatarGlasses) => void;
}) {
  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-mist">Color</legend>
        <div className="flex flex-wrap gap-2">
          {AVATAR_COLORS.map((option) => (
            <button
              key={option.id}
              aria-label={option.label}
              aria-pressed={color === option.id}
              className={`avatar-swatch ${color === option.id ? "is-selected" : ""}`}
              onClick={() => onColorChange(option.id)}
              title={option.label}
              type="button"
            >
              <span style={{ backgroundColor: option.swatch }} />
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="mb-2 text-[10px] font-semibold uppercase tracking-[0.15em] text-mist">Glasses</legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl border border-line bg-black/20 p-1">
          {AVATAR_GLASSES.map((option) => (
            <button
              key={option.id}
              aria-pressed={glasses === option.id}
              className={`rounded-lg px-2 py-2 text-[11px] font-medium transition-all ${
                glasses === option.id
                  ? "bg-white/10 text-snow ring-1 ring-white/10"
                  : "text-mist hover:bg-white/5 hover:text-snow"
              }`}
              onClick={() => onGlassesChange(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>
    </div>
  );
}
