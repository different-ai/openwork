/** @jsxImportSource react */
export type OwDotTickerProps = {
  size?: "sm" | "md" | "lg";
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
