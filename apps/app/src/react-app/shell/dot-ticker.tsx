/** @jsxImportSource react */
/**
 * A dot-matrix style indicator that animates in a 3x3 grid pattern.
 * Used for: awaiting first response token, preparing workspace, any "alive
 * but idle" state. Dots pulse with staggered timing for a rhythmic,
 * dotmatrix-inspired beat.
 */
export type OwDotTickerProps = {
  /**
   * Compact for inline hints ("sm"), default for the composer wait
   * state ("md"), and larger for the boot overlay ("lg").
   */
  size?: "sm" | "md" | "lg";
  /** Ignored (kept for API compat). Grid is always 3x3 = 9 dots. */
  count?: number;
  className?: string;
};

const SIZE_CONFIG: Record<NonNullable<OwDotTickerProps["size"]>, {
  dotSize: number;
  gap: number;
  outer: number;
}> = {
  sm: { dotSize: 2, gap: 2, outer: 10 },
  md: { dotSize: 3, gap: 2, outer: 13 },
  lg: { dotSize: 4, gap: 3, outer: 18 },
};

const GRID = 3;
const DOT_COUNT = GRID * GRID;

/** Spiral traversal order for a 3x3 grid -- outside in. */
const SPIRAL_ORDER = [0, 1, 2, 5, 8, 7, 6, 3, 4];

export function OwDotTicker(props: OwDotTickerProps) {
  const size = props.size ?? "md";
  const config = SIZE_CONFIG[size];
  const duration = 1.6;
  const step = duration / DOT_COUNT;

  return (
    <div
      className={`inline-grid ${props.className ?? ""}`}
      style={{
        gridTemplateColumns: `repeat(${GRID}, ${config.dotSize}px)`,
        gap: config.gap,
        width: config.outer,
        height: config.outer,
      }}
      role="presentation"
      aria-hidden="true"
    >
      {Array.from({ length: DOT_COUNT }).map((_, i) => {
        const spiralIndex = SPIRAL_ORDER[i];
        return (
          <span
            key={i}
            className="ow-dot-ticker rounded-full"
            style={{
              width: config.dotSize,
              height: config.dotSize,
              animationDelay: `${(spiralIndex * step).toFixed(3)}s`,
            }}
          />
        );
      })}
    </div>
  );
}
