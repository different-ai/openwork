/** @jsxImportSource react */
import * as React from "react";

import { cn } from "@/lib/utils";

/** Sub-pixel rounding between scrollWidth and clientWidth must not count as hidden text. */
export const OVERFLOW_FADE_TOLERANCE_PX = 1;

/**
 * A label hides text only when its content is wider than the box that clips it.
 * The fade is a signal that more text exists beyond the edge, so it must never
 * appear on a label that fits.
 */
export function resolveOverflowFade({
  clientWidth,
  scrollWidth,
}: {
  clientWidth: number;
  scrollWidth: number;
}): boolean {
  return scrollWidth - clientWidth > OVERFLOW_FADE_TOLERANCE_PX;
}

type OverflowFadeLabelProps = React.HTMLAttributes<HTMLSpanElement> & {
  children: React.ReactNode;
};

/**
 * Single-line label that fades its trailing edge only while text is actually
 * clipped. The box always spans its parent so the fade sits on the container
 * edge, not on the end of the text; a static `.ow-fade-truncate` on a
 * shrink-to-fit span dimmed the last letters of every workspace name.
 */
export function OverflowFadeLabel({ children, className, ...rest }: OverflowFadeLabelProps) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = React.useState(false);

  React.useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = () => {
      setOverflowing(resolveOverflowFade({ clientWidth: node.clientWidth, scrollWidth: node.scrollWidth }));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [children]);

  return (
    <span
      {...rest}
      ref={ref}
      className={cn(
        "block w-full min-w-0 overflow-hidden whitespace-nowrap",
        overflowing && "ow-fade-truncate",
        className,
      )}
      data-overflow-fade-label
      data-overflowing={overflowing ? "true" : undefined}
    >
      {children}
    </span>
  );
}
