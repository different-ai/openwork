"use client"

import { useState, type ReactNode } from "react"
import { MoreHorizontal } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { t } from "@/i18n"
import { commandProgram } from "@/lib/text-activity"
import { cn } from "@/lib/utils"

/** Lines of output shown before "Show more". */
const OUTPUT_PREVIEW_LINES = 12

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // Clipboard access can be unavailable outside a secure browser context.
  }
}

function previewLines(text: string, expanded: boolean): { text: string; clipped: boolean } {
  const lines = text.split("\n")
  if (expanded || lines.length <= OUTPUT_PREVIEW_LINES) return { text, clipped: false }
  return { text: lines.slice(0, OUTPUT_PREVIEW_LINES).join("\n"), clipped: true }
}

function ShowMore({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} className="mt-1 w-fit font-sans text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
      {expanded ? t("text_activity.show_less") : t("text_activity.show_more")}
    </button>
  )
}

/**
 * An opened command (text-first): one quiet card under its row. The command
 * first (`$` muted, the program tinted like a shell prompt, the rest in ink,
 * wrapping), then its output in lighter mono capped with "Show more", and a
 * `…` menu to copy either. It replaces a separate Technical details box.
 */
export function TextCommandCard({ command, output, failed = false }: { command: string; output: string | null; failed?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const { program, rest } = commandProgram(command)
  const shown = output ? previewLines(output.trimEnd(), expanded) : null
  return (
    <div data-text-command-card="" className="relative min-w-0 rounded-[10px] border border-border bg-background px-3 py-2 pe-9 font-mono text-[12.5px] leading-5">
      <p className="whitespace-pre-wrap break-all text-foreground">
        <span className="select-none text-muted-foreground">$ </span>
        <span className="text-orange-11">{program}</span>
        {rest}
      </p>
      {shown ? (
        <div className="mt-1.5 flex flex-col">
          <pre data-text-command-output="" data-failed={failed ? "" : undefined} className="whitespace-pre-wrap break-all font-mono text-slate-9">{shown.text}</pre>
          {shown.clipped || expanded ? <ShowMore expanded={expanded} onToggle={() => setExpanded(!expanded)} /> : null}
        </div>
      ) : null}
      <div className="absolute end-1.5 top-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="ghost" size="icon-xs" className="text-muted-foreground" aria-label={t("text_activity.command_actions")}>
                <MoreHorizontal aria-hidden="true" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-40">
            <DropdownMenuItem onClick={() => void copyText(command)}>{t("text_activity.copy_command")}</DropdownMenuItem>
            {output ? <DropdownMenuItem onClick={() => void copyText(output)}>{t("text_activity.copy_output")}</DropdownMenuItem> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}

/**
 * An opened edit or write: the change in the same quiet card, removed lines
 * marked − in red and added lines + in green, capped with "Show more".
 */
export function TextDiffCard({ removed, added }: { removed: string | null; added: string | null }) {
  const [expanded, setExpanded] = useState(false)
  const rows = [
    ...(removed ? removed.replace(/\n$/, "").split("\n").map((line) => ({ sign: "−", line, tone: "text-red-11" })) : []),
    ...(added ? added.replace(/\n$/, "").split("\n").map((line) => ({ sign: "+", line, tone: "text-green-11" })) : []),
  ]
  if (rows.length === 0) return null
  const clipped = !expanded && rows.length > OUTPUT_PREVIEW_LINES
  const visible = clipped ? rows.slice(0, OUTPUT_PREVIEW_LINES) : rows
  return (
    <div data-text-diff-card="" className="min-w-0 rounded-[10px] border border-border bg-background px-3 py-2 font-mono text-[12.5px] leading-5">
      {visible.map((row, index) => (
        <div key={index} className="flex min-w-0 gap-2">
          <span className={cn("shrink-0 select-none", row.tone)}>{row.sign}</span>
          <span className="min-w-0 whitespace-pre-wrap break-all text-foreground">{row.line || " "}</span>
        </div>
      ))}
      {clipped || expanded ? <ShowMore expanded={expanded} onToggle={() => setExpanded(!expanded)} /> : null}
    </div>
  )
}

/**
 * Raw output behind a failed step (T2): a quiet "Technical details" box,
 * slate-2 with an inset hairline and small mono text. Label only above it.
 */
export function TextTechnicalDetails({ children }: { children: ReactNode }) {
  return (
    <div data-text-technical-details="" className="flex min-w-0 flex-col gap-1">
      <span className="text-xs text-muted-foreground">{t("text_activity.technical_details")}</span>
      <div className="max-h-60 min-w-0 overflow-auto rounded-md bg-gray-2 p-2.5 font-mono text-[11.5px] leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--border)]">
        {children}
      </div>
    </div>
  )
}

/** "+11 −3" after an edit's sentence, green and red, only when counts are known. */
export function TextDiffStats({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null
  return (
    <span data-text-diff-stats="" className="shrink-0 text-xs tabular-nums">
      {added > 0 ? <span className="text-green-11" aria-label={t("text_activity.lines_added", { count: added })}>+{added}</span> : null}
      {added > 0 && removed > 0 ? " " : null}
      {removed > 0 ? <span className="text-red-11" aria-label={t("text_activity.lines_removed", { count: removed })}>−{removed}</span> : null}
    </span>
  )
}
