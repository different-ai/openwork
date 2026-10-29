"use client"

import type * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The turn's activity rail (DESIGN.md T1): every step, group and summary line
 * shares one leading 20px lane (logo, glyph, spinner or chevron), 13px muted
 * sentence text, durations in a trailing 11px lane, and the details icon in a
 * reserved slot after it. Rows sit in containers that space parts 8px apart;
 * pulling each row 4px in keeps consecutive steps on a 26px rhythm.
 */
export const RAIL_ROW = "group/step -my-1 min-w-0"
export const RAIL_LINE = "flex min-h-6.5 min-w-0 items-center gap-2 text-sm text-muted-foreground"

export function LeadingLane({ children, className }: { children?: React.ReactNode; className?: string }) {
  return <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center", className)}>{children}</span>
}

/** A disclosure chevron in the leading lane; rotates 90° when open (S3). */
export function LaneChevron({ open }: { open: boolean }) {
  return (
    <LeadingLane>
      <ChevronRight className={cn("size-3 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
    </LeadingLane>
  )
}

/** Duration in its own trailing lane, aligned down the rail. */
export function RailDuration({ value }: { value: string | null | undefined }) {
  return value ? <span className="ms-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/80">{value}</span> : null
}

/** Quiet metadata beside a label ("3 steps", "1 failed"), never a middle-dot string (C7). */
export function RailMeta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("shrink-0 text-[11px] text-muted-foreground/80", className)}>{children}</span>
}
