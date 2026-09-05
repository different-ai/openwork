"use client"

import { ArrowUpRight } from "lucide-react"

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
 * reference is a quiet inline chip — basename in mono on the same soft
 * background as inline code in chat prose (no border, no icon), full
 * path in the tooltip. Click opens the artifact preview; the ↗ that
 * appears on hover opens the file in the default app.
 */
export function FileChip({ path, className }: FileChipProps) {
  const openArtifactPath = useOpenArtifactPath()
  const name = baseName(path)

  return (
    <span
      className={cn(
        "group/chip inline-flex items-center overflow-hidden rounded-md bg-gray-2/70 align-middle",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => openArtifactPath(path)}
        title={path}
        className="flex min-w-0 cursor-pointer items-center px-1.5 py-0.5 transition-colors hover:bg-gray-3/80"
      >
        <span className="min-w-0 truncate font-mono text-[11px] leading-4 text-foreground">
          {name}
        </span>
      </button>
      <button
        type="button"
        onClick={() => openArtifactPath(path, { external: true })}
        title={`Open ${name} in default app`}
        aria-label={`Open ${name} in default app`}
        className="flex cursor-pointer items-center pr-1.5 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/chip:opacity-100 hover:text-foreground"
      >
        <ArrowUpRight aria-hidden="true" className="size-2.5" />
      </button>
    </span>
  )
}
