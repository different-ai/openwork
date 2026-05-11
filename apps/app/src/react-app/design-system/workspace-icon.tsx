/** @jsxImportSource react */
import { PaperGrainGradient } from "@openwork/ui/react";

export type WorkspaceIconProps = {
  /** Workspace ID or name used to seed the gradient. */
  seed: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
};

/**
 * Bright, vibrant palette families -- no blacks, no dark colors.
 * Each family has 4 colors that blend well as a grain gradient at small sizes.
 */
const palettes = [
  ["#818cf8", "#c084fc", "#f0abfc", "#e879f9"], // indigo-purple-pink
  ["#34d399", "#6ee7b7", "#a7f3d0", "#5eead4"], // emerald-teal
  ["#fb923c", "#fbbf24", "#fde68a", "#f97316"], // orange-amber
  ["#60a5fa", "#93c5fd", "#7dd3fc", "#38bdf8"], // blue-sky
  ["#f472b6", "#fb7185", "#fda4af", "#f9a8d4"], // pink-rose
  ["#a78bfa", "#818cf8", "#c4b5fd", "#ddd6fe"], // violet-lavender
  ["#4ade80", "#86efac", "#bbf7d0", "#a3e635"], // green-lime
  ["#fcd34d", "#fde047", "#fef08a", "#fdba74"], // yellow-gold
];

const shapes = ["corners", "wave", "dots", "blob", "sphere"] as const;

/** Simple deterministic hash (DJB2). */
function hashSeed(input: string): number {
  const value = input.trim() || "workspace";
  let hash = 5381;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Renders a small rounded circle with a deterministic Paper grain gradient
 * seeded by the workspace identifier. Uses bright, vibrant colors only.
 */
export function WorkspaceIcon({ seed, sizeClass = "size-4" }: WorkspaceIconProps) {
  const hash = hashSeed(seed);
  const colors = palettes[hash % palettes.length];
  const shape = shapes[(hash >> 3) % shapes.length];
  const frame = (hash % 30000) + 5000;

  return (
    <div className={`${sizeClass} shrink-0 overflow-hidden rounded-full`}>
      <PaperGrainGradient
        speed={0}
        frame={frame}
        colors={colors}
        colorBack="#ffffff00"
        softness={0.5}
        intensity={0.6}
        noise={0.2}
        shape={shape}
        style={{ backgroundColor: colors[0], width: "100%", height: "100%" }}
      />
    </div>
  );
}
