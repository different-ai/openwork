/** @jsxImportSource react */
import { PaperGrainGradient } from "@openwork/ui/react";

export type WorkspaceIconProps = {
  /** Workspace ID or name used to seed the gradient. */
  seed: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
};

/**
 * High-contrast palette families designed to look interesting at small sizes.
 * Each family uses complementary or split-complementary colors so the gradient
 * has visible structure even at 16px.
 */
const palettes = [
  ["#6366f1", "#f43f5e", "#fbbf24", "#06b6d4"], // indigo + rose + amber + cyan
  ["#8b5cf6", "#10b981", "#f97316", "#ec4899"], // violet + emerald + orange + pink
  ["#0ea5e9", "#f59e0b", "#ef4444", "#22c55e"], // sky + amber + red + green
  ["#d946ef", "#14b8a6", "#f97316", "#6366f1"], // fuchsia + teal + orange + indigo
  ["#f43f5e", "#3b82f6", "#a3e635", "#f59e0b"], // rose + blue + lime + amber
  ["#06b6d4", "#e879f9", "#fbbf24", "#34d399"], // cyan + pink + gold + emerald
  ["#8b5cf6", "#f97316", "#06b6d4", "#f43f5e"], // violet + orange + cyan + rose
  ["#ec4899", "#fbbf24", "#22c55e", "#6366f1"], // pink + amber + green + indigo
  ["#14b8a6", "#f43f5e", "#a78bfa", "#f59e0b"], // teal + rose + violet + amber
  ["#3b82f6", "#ef4444", "#10b981", "#f59e0b"], // blue + red + emerald + amber
];

/** Shapes that produce the most visible structure at tiny sizes. */
const shapes = ["corners", "ripple", "sphere", "blob"] as const;

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
 * seeded by the workspace identifier. High-contrast complementary colors
 * ensure the gradient looks interesting even at 16px.
 */
export function WorkspaceIcon({ seed, sizeClass = "size-4" }: WorkspaceIconProps) {
  const hash = hashSeed(seed);
  const colors = palettes[hash % palettes.length];
  const shape = shapes[(hash >> 4) % shapes.length];
  // Spread frame values wider so each workspace lands on a visually distinct moment
  const frame = ((hash * 7) % 200000) + 10000;

  return (
    <div className={`${sizeClass} shrink-0 overflow-hidden rounded-full`}>
      <PaperGrainGradient
        speed={0}
        frame={frame}
        colors={colors}
        colorBack="#ffffff00"
        softness={0.35}
        intensity={0.75}
        noise={0.15}
        shape={shape}
        style={{ backgroundColor: colors[0], width: "100%", height: "100%" }}
      />
    </div>
  );
}
