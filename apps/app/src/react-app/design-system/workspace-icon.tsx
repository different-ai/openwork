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
  ["#7c8cf5", "#e8789c", "#e4a853", "#5cb8c4"], // soft indigo + muted rose + warm gold + soft teal
  ["#9b8afb", "#5aab8e", "#d98a54", "#d07eb5"], // soft violet + sage + copper + dusty pink
  ["#5a9fd4", "#d4a44c", "#cc7070", "#6aad7a"], // soft blue + warm gold + dusty red + sage green
  ["#c27dd8", "#5a9e93", "#d4914e", "#7c8cf5"], // soft purple + muted teal + copper + soft indigo
  ["#d47580", "#6b8fd4", "#8aad5a", "#d4a44c"], // dusty rose + soft blue + olive + warm gold
  ["#5cb8c4", "#b572c4", "#d4a44c", "#5aab8e"], // soft teal + muted purple + warm gold + sage
  ["#9b8afb", "#d4914e", "#5cb8c4", "#d47580"], // soft violet + copper + soft teal + dusty rose
  ["#c47082", "#d4a44c", "#6aad7a", "#7c8cf5"], // muted rose + warm gold + sage green + soft indigo
  ["#5a9e93", "#d47580", "#9b8afb", "#d4a44c"], // muted teal + dusty rose + soft violet + warm gold
  ["#6b8fd4", "#c47070", "#5aab8e", "#d4914e"], // soft blue + muted red + sage + copper
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
