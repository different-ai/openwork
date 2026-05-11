/** @jsxImportSource react */
import { useMemo } from "react";
import { PaperGrainGradient } from "@openwork/ui/react";

export type WorkspaceIconProps = {
  /** Workspace name used to seed the gradient. Changes when renamed. */
  seed: string;
  /** CSS size class, e.g. "size-4", "size-5.5". Defaults to "size-4". */
  sizeClass?: string;
};

/**
 * Deeper, more professional palette families. Each uses complementary
 * tones with enough contrast to read at 16px but avoids the neon/playful
 * look of pure saturated colors.
 */
const palettes = [
  ["#4338ca", "#be185d", "#b45309", "#0e7490"], // deep indigo + deep rose + dark amber + dark cyan
  ["#6d28d9", "#047857", "#c2410c", "#be185d"], // deep violet + deep emerald + burnt orange + deep rose
  ["#0369a1", "#a16207", "#b91c1c", "#15803d"], // deep sky + dark gold + deep red + deep green
  ["#a21caf", "#0f766e", "#c2410c", "#4338ca"], // deep fuchsia + dark teal + burnt orange + deep indigo
  ["#be123c", "#1d4ed8", "#4d7c0f", "#a16207"], // deep rose + deep blue + olive + dark gold
  ["#0e7490", "#86198f", "#a16207", "#047857"], // dark cyan + deep purple + dark gold + deep emerald
  ["#6d28d9", "#c2410c", "#0e7490", "#be123c"], // deep violet + burnt orange + dark cyan + deep rose
  ["#9f1239", "#a16207", "#15803d", "#4338ca"], // dark rose + dark gold + deep green + deep indigo
  ["#0f766e", "#be123c", "#6d28d9", "#a16207"], // dark teal + deep rose + deep violet + dark gold
  ["#1d4ed8", "#991b1b", "#047857", "#b45309"], // deep blue + dark red + deep emerald + dark amber
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
 * seeded by the workspace name. Renaming the workspace changes the gradient.
 * Uses deeper, more professional color palettes.
 */
export function WorkspaceIcon({ seed, sizeClass = "size-4" }: WorkspaceIconProps) {
  const config = useMemo(() => {
    const hash = hashSeed(seed);
    return {
      colors: palettes[hash % palettes.length],
      shape: shapes[(hash >> 4) % shapes.length],
      frame: ((hash * 7) % 200000) + 10000,
    };
  }, [seed]);

  return (
    <div className={`${sizeClass} shrink-0 overflow-hidden rounded-full`}>
      <PaperGrainGradient
        speed={0}
        frame={config.frame}
        colors={config.colors}
        colorBack="#ffffff00"
        softness={0.3}
        intensity={0.8}
        noise={0.12}
        shape={config.shape}
        style={{ backgroundColor: config.colors[0], width: "100%", height: "100%" }}
      />
    </div>
  );
}
