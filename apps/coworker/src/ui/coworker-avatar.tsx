import type { AvatarColor, AvatarGlasses } from "@/lib/bridge";

const AVATAR_COLORS: Array<{ id: AvatarColor; label: string; swatch: string }> = [
  { id: "blue", label: "OpenWork blue", swatch: "#91adf0" },
  { id: "violet", label: "Violet", swatch: "#aaa0dc" },
  { id: "mint", label: "Mint", swatch: "#82c7b3" },
  { id: "orange", label: "Orange", swatch: "#d9a17d" },
  { id: "rose", label: "Rose", swatch: "#daa0b2" },
  { id: "slate", label: "Slate", swatch: "#a6b1c0" },
];

const AVATAR_GLASSES: Array<{ id: AvatarGlasses; label: string }> = [
  { id: "round", label: "Round" },
  { id: "square", label: "Soft square" },
  { id: "none", label: "None" },
];

const PALETTES: Record<AvatarColor, { fill: string; edge: string }> = {
  blue: { fill: "#91adf0", edge: "#7898e4" },
  violet: { fill: "#aaa0dc", edge: "#9186ce" },
  mint: { fill: "#82c7b3", edge: "#69b6a0" },
  orange: { fill: "#d9a17d", edge: "#cb8962" },
  rose: { fill: "#daa0b2", edge: "#cb879d" },
  slate: { fill: "#a6b1c0", edge: "#8d9aac" },
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

  return (
    <svg
      aria-label={`${name || "Coworker"} avatar`}
      className={`coworker-avatar ${motionClass} ${working ? "is-working" : ""}`}
      role="img"
      style={{ width: size, height: size }}
      viewBox="0 0 120 124"
    >
      <g className="coworker-avatar__body">
        <path
          d="M27 10h62c15 0 24 10 24 26v41c0 16-9 25-24 25H55l-15 10c-5 3-10 0-10-6v-4h-3C12 102 4 93 4 77V36c0-16 8-26 23-26Z"
          fill={palette.fill}
          stroke={palette.edge}
          strokeWidth="1.5"
        />
        <path
          d="M27 13h61c12 0 20 7 22 19"
          fill="none"
          stroke="#ffffff"
          strokeLinecap="round"
          strokeOpacity="0.2"
          strokeWidth="1.25"
        />

        <g className="coworker-avatar__pupils" fill="#0b0e14">
          <rect x="37" y="50" width="6" height="14" rx="3" />
          <rect x="74" y="50" width="6" height="14" rx="3" />
        </g>

        {glasses === "round" ? (
          <g fill="none" stroke="#111722" strokeLinecap="round" strokeWidth="5.5">
            <circle cx="40" cy="57" r="17" />
            <circle cx="77" cy="57" r="17" />
            <path d="M57 55.5h3" />
            <path d="M20 57h3M94 57h3" />
          </g>
        ) : null}
        {glasses === "square" ? (
          <g fill="none" stroke="#111722" strokeLinecap="round" strokeLinejoin="round" strokeWidth="5.5">
            <rect x="22.5" y="40" width="35" height="34" rx="9" />
            <rect x="59.5" y="40" width="35" height="34" rx="9" />
            <path d="M57 54.5h3" />
            <path d="M20 57h3M95 57h3" />
          </g>
        ) : null}
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
