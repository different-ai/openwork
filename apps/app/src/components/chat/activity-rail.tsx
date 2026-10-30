"use client"

import type * as React from "react"
import { ChevronRight } from "lucide-react"

import { useTextActivityRail } from "@/components/chat/text-activity-rail-store"
import { cn } from "@/lib/utils"

/**
 * The turn's activity rail (DESIGN.md T1): every step, group and summary line
 * shares one leading 20px lane (logo, glyph, spinner or chevron), 13px muted
 * sentence text, durations in a trailing 11px lane, and the details icon in a
 * reserved slot after it. Rows sit in containers that space parts 8px apart;
 * pulling each row 4px in keeps consecutive steps on a 26px rhythm.
 *
 * With `textActivityRail` on, the rail is text-first: no leading lane, every
 * line starts on the reply text's left edge, a brand mark sits inline after
 * the verb ("Searched [mark] your connections…"), the chevron trails the text,
 * and there is no duration lane. Each primitive below switches itself, so
 * callers render the same tree either way and the flag-off rail is unchanged.
 */
export const RAIL_ROW = "group/step -my-1 min-w-0"
export const RAIL_LINE = "flex min-h-6.5 min-w-0 items-center gap-2 text-sm text-muted-foreground"

export function LeadingLane({ children, className }: { children?: React.ReactNode; className?: string }) {
  const text = useTextActivityRail()
  // Text-first: no lane at all, so every line starts on the reply's left
  // edge. Brand marks move into the sentence (`TextSentenceLine` `mark`).
  if (text) return null
  return <span aria-hidden="true" className={cn("flex size-5 shrink-0 items-center justify-center", className)}>{children}</span>
}

/** A disclosure chevron in the leading lane; rotates 90° when open (S3). */
export function LaneChevron({ open }: { open: boolean }) {
  const text = useTextActivityRail()
  if (text) return null
  return (
    <LeadingLane>
      <ChevronRight className={cn("size-3 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90")} />
    </LeadingLane>
  )
}

/**
 * Text-first disclosure chevron, after the text: right when closed, down
 * when open. Renders nothing on the previous rail, where `LaneChevron` leads.
 */
export function TrailingChevron({ open, className }: { open: boolean; className?: string }) {
  const text = useTextActivityRail()
  if (!text) return null
  return (
    <ChevronRight
      aria-hidden="true"
      data-text-rail-chevron=""
      className={cn("size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90", className)}
    />
  )
}

/** Duration in its own trailing lane, aligned down the rail. Text-first has no duration lane. */
export function RailDuration({ value }: { value: string | null | undefined }) {
  const text = useTextActivityRail()
  if (text) return null
  return value ? <span className="ms-auto shrink-0 text-[11px] tabular-nums text-muted-foreground/80">{value}</span> : null
}

/** Quiet metadata beside a label ("3 steps", "1 failed"), never a middle-dot string (C7). */
export function RailMeta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("shrink-0 text-[11px] text-muted-foreground/80", className)}>{children}</span>
}

/**
 * "Verb object" (text-first): the verb in muted ink, the object lighter,
 * one line, truncated. Failed verbs are red; waiting is amber; the running
 * step shimmers (V6, reduced motion respected).
 */
export function TextSentenceLine({ verb, object, mark, title, tone = "normal", className }: {
  verb: string
  object?: string
  /** A real brand mark, inline between the verb and its object. */
  mark?: React.ReactNode
  title?: string
  tone?: "normal" | "running" | "failed" | "waiting"
  className?: string
}) {
  return (
    <span
      data-text-step=""
      data-text-step-tone={tone}
      title={title}
      className={cn("min-w-0 truncate", tone === "running" && "ow-text-shimmer motion-reduce:animate-none", className)}
    >
      {/* The shimmer paints through the text, so a running step's parts keep no colour of their own. */}
      <span className={cn(tone === "failed" ? "text-red-11" : tone === "waiting" ? "text-amber-11" : tone === "running" ? null : "text-muted-foreground")}>{verb}</span>
      {mark ? <span data-text-rail-mark="" className="ms-1 inline-flex align-[-0.2em]">{mark}</span> : null}
      {object ? <span className={cn(tone !== "running" && "text-slate-9")}>{` ${object}`}</span> : null}
    </span>
  )
}
