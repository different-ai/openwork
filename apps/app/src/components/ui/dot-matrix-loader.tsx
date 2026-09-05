import * as React from "react"

import { cn } from "@/lib/utils"

type DotMatrixLoaderProps = React.ComponentPropsWithoutRef<"span"> & {
  className?: string
  label: string
}

/**
 * Paper rendering rules: 3×3 dot-matrix is the only "living mark" for
 * running work (sidebar rows, transcript tool lines). CSS shuffles the frames
 * without publishing React state on every animation step. Under
 * prefers-reduced-motion the first frame remains static.
 */
const FIRST_FRAME: readonly number[] = [1, 0, 0, 1, 1, 0, 1, 0, 1]
const DOT_ANIMATION_CLASSES = [
  "ow-dot-matrix-frame-a",
  "ow-dot-matrix-frame-b",
  "ow-dot-matrix-frame-c",
  "ow-dot-matrix-frame-d",
  "ow-dot-matrix-frame-e",
  "ow-dot-matrix-frame-f",
  "ow-dot-matrix-frame-e",
  "ow-dot-matrix-frame-f",
  "ow-dot-matrix-frame-g",
]

export function DotMatrixLoader({ className, label, ...rest }: DotMatrixLoaderProps) {
  return (
    <span
      {...rest}
      role="status"
      aria-label={label}
      title={label}
      className={cn("inline-grid size-3.5 shrink-0 grid-cols-3 grid-rows-3 gap-px", className)}
    >
      {FIRST_FRAME.map((lit, index) => (
        <span
          key={index}
          aria-hidden="true"
          className={cn(
            "ow-dot-matrix-dot size-full rounded-full bg-current",
            lit ? "ow-dot-matrix-on" : "ow-dot-matrix-off",
            DOT_ANIMATION_CLASSES[index],
          )}
        />
      ))}
    </span>
  )
}
