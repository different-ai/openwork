"use client"

import type * as React from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

/**
 * The turn's text-first activity rail: sentences share the reply's left edge,
 * brand marks sit after the verb, and disclosure chevrons trail the text.
 */
export const RAIL_ROW = "group/step -my-1 min-w-0"
export const RAIL_LINE = "flex min-h-6.5 min-w-0 items-center gap-2 text-sm text-muted-foreground"

/** A trailing disclosure chevron; rotates 90° when open (S3). */
export function TrailingChevron({ open, className }: { open: boolean; className?: string }) {
  return (
    <ChevronRight
      aria-hidden="true"
      data-text-rail-chevron=""
      className={cn("size-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 ease-out motion-reduce:transition-none", open && "rotate-90", className)}
    />
  )
}

/** Quiet metadata beside a label ("3 steps", "1 failed"), never a middle-dot string (C7). */
export function RailMeta({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={cn("shrink-0 text-[11px] text-muted-foreground/80", className)}>{children}</span>
}

/**
 * "Verb object" (text-first): the verb in muted ink, the object lighter,
 * one line, truncated. Failed verbs are red; waiting is amber; a running
 * step's verb is in full ink and holds still: the turn's Working line is the
 * one shimmer on screen, so two lines never sweep at once.
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
      className={cn("min-w-0 truncate", className)}
    >
      <span className={cn(tone === "failed" ? "text-red-11" : tone === "waiting" ? "text-amber-11" : tone === "running" ? "text-foreground" : "text-muted-foreground")}>{verb}</span>
      {mark ? <span data-text-rail-mark="" className="ms-1 inline-flex align-[-0.2em]">{mark}</span> : null}
      {object ? <span className="text-slate-9">{` ${object}`}</span> : null}
    </span>
  )
}
