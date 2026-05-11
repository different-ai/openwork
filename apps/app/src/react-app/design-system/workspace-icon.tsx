/** @jsxImportSource react */

export type WorkspaceIconProps = {
  /** Workspace ID or name used to seed the dot colors. */
  seed: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
  /** When true, dots animate (session is active/running). */
  active?: boolean;
};

/**
 * Bright gradient color pairs -- each pair produces a 2-stop gradient for a dot.
 * No blacks, no dark colors.
 */
const gradients = [
  ["#818cf8", "#c084fc"], // indigo → purple
  ["#34d399", "#5eead4"], // emerald → teal
  ["#fb923c", "#fbbf24"], // orange → amber
  ["#60a5fa", "#38bdf8"], // blue → sky
  ["#f472b6", "#fb7185"], // pink → rose
  ["#a78bfa", "#ddd6fe"], // violet → lavender
  ["#4ade80", "#a3e635"], // green → lime
  ["#fcd34d", "#fdba74"], // yellow → gold
  ["#f97316", "#ef4444"], // orange → red
  ["#06b6d4", "#22d3ee"], // cyan → light cyan
];

/** Simple deterministic hash. */
function hashSeed(input: string): number {
  const value = input.trim() || "workspace";
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/** Get a seeded gradient for a specific dot index within a workspace. */
function dotGradient(hash: number, dotIndex: number): string {
  const idx = (hash + dotIndex * 7) % gradients.length;
  const [from, to] = gradients[idx];
  return `linear-gradient(135deg, ${from}, ${to})`;
}

/** Seeded opacity per dot for visual variety. */
function dotOpacity(hash: number, dotIndex: number): number {
  const base = 0.5;
  const variation = ((hash * (dotIndex + 3) * 13) % 50) / 100;
  return base + variation;
}

const GRID = 3;
const DOT_COUNT = GRID * GRID;

/**
 * Renders a small dot-matrix icon with seeded gradient colors per dot.
 * Static when idle, animated pulse when active (session running).
 */
export function WorkspaceIcon({ seed, sizeClass = "size-4", active = false }: WorkspaceIconProps) {
  const hash = hashSeed(seed);

  return (
    <div
      className={`${sizeClass} shrink-0 overflow-hidden rounded-full`}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${GRID}, 1fr)`,
        gap: "1px",
        padding: "1px",
      }}
    >
      {Array.from({ length: DOT_COUNT }, (_, i) => (
        <span
          key={i}
          style={{
            borderRadius: "50%",
            background: dotGradient(hash, i),
            opacity: dotOpacity(hash, i),
            aspectRatio: "1",
            animation: active
              ? `workspace-dot-pulse ${0.6 + ((hash + i * 5) % 8) * 0.1}s ease-in-out infinite alternate`
              : "none",
            animationDelay: active ? `${(i * 80) % 500}ms` : "0ms",
          }}
        />
      ))}
    </div>
  );
}
