/** @jsxImportSource react */
/**
 * A small row of dots (`:: :: ::`) that illuminate one after another from left
 * to right. Deliberately quiet: no shadow, no card, no glass — just a few
 * pixels of accent light walking across a track.
 *
 * Used for: awaiting first response token, preparing workspace, any "alive
 * but idle" state where we want a rhythmic beat that doesn't compete with the
 * rest of the UI.
 */
export type OwDotTickerProps = {
  /**
   * Compact rows for inline hints ("sm"), default rows for the composer wait
   * state ("md"), and the larger row used on the boot overlay ("lg").
   */
  size?: "sm" | "md" | "lg";
  /** Total number of dots in the track. Defaults to 7. */
  count?: number;
  className?: string;
};

const SIZE_CONFIG: Record<NonNullable<OwDotTickerProps["size"]>, {
  dotSize: string;
  gap: string;
}> = {
  sm: { dotSize: "h-[3px] w-[3px]", gap: "gap-[5px]" },
  md: { dotSize: "h-1 w-1", gap: "gap-1.5" },
  lg: { dotSize: "h-[6px] w-[6px]", gap: "gap-2" },
};

export function OwDotTicker(props: OwDotTickerProps) {
  const size = props.size ?? "md";
  const count = Math.max(3, Math.min(props.count ?? 7, 12));
  const config = SIZE_CONFIG[size];
  const duration = 1.4;
  const step = duration / count;

  return (
    <div
      className={`inline-flex items-center ${config.gap} ${props.className ?? ""}`}
      role="presentation"
      aria-hidden="true"
    >
      {Array.from({ length: count }).map((_, index) => (
        <span
          key={index}
          className={`ow-dot-ticker rounded-full ${config.dotSize}`}
          style={{ animationDelay: `${(index * step).toFixed(3)}s` }}
        />
      ))}
    </div>
  );
}
