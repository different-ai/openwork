"use client"

import { ArrowUpRight, FileText } from "lucide-react"

import { useOpenArtifactPath } from "@/lib/artifacts"
import { cn } from "@/lib/utils"

type FileChipProps = {
  /** Full (possibly absolute) file path; only the basename is shown. */
  path: string
  className?: string
}

function baseName(path: string): string {
  const segments = path.split(/[/\\]/)
  return segments[segments.length - 1] || path
}

/**
 * Paper "File paths → chips": never render raw absolute paths. A file
 * reference is an inline chip — icon + basename in mono, full path in
 * the tooltip. Click opens the artifact preview; ↗ opens the file in
 * the default app. Used in aggregate rows, failure reasons, and prose.
 */
export function FileChip({ path, className }: FileChipProps) {
  const openArtifactPath = useOpenArtifactPath()
  const name = baseName(path)

  return (
    <span
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-md border border-border/70 bg-muted/50 align-middle",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => openArtifactPath(path)}
        title={path}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 px-1.5 py-0.5 transition-colors hover:bg-muted"
      >
        <FileText aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-foreground">
          {name}
        </span>
      </button>
      <button
        type="button"
        onClick={() => openArtifactPath(path, { external: true })}
        title={`Open ${name} in default app`}
        aria-label={`Open ${name} in default app`}
        className="flex cursor-pointer items-center border-l border-border/60 px-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ArrowUpRight aria-hidden="true" className="size-2.5" />
      </button>
    </span>
  )
}
