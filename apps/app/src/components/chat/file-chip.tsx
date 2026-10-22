"use client"

import { ArrowUpRight } from "lucide-react"

import { useOpenArtifactPath } from "@/lib/artifacts"
import { ActionContextMenu } from "@/components/ui/action-context-menu"
import { toast } from "@/components/ui/sonner"
import { cn } from "@/lib/utils"
import { useOpenTargets } from "@/lib/target-provider"
import { usePlatform } from "@/react-app/kernel/platform"
import { nativeFileAction, openTargetForHref } from "@/react-app/domains/session/artifacts/resolve-open-target"

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
  const platform = usePlatform()
  const { workspaceRoot, isLocalWorkspace, openTargets } = useOpenTargets()
  const target = openTargetForHref(path, openTargets, workspaceRoot)
  const native = target?.kind === "file" ? nativeFileAction(workspaceRoot, target.value, {
    isLocalWorkspace: isLocalWorkspace === true,
    canUseDesktop: platform.capabilities.revealInFileManager,
    os: platform.os,
    exists: target.exists,
  }) : null
  const nativeLabel = native?.action === "reveal" ? "Show in folder" : "Open in default app"

  return (
    <ActionContextMenu
      render={<span />}
      actions={[
        { type: "item", id: "open", label: "Open file", onSelect: () => openArtifactPath(path) },
        ...(native ? [{ type: "item" as const, id: "open-external", label: nativeLabel, onSelect: () => openArtifactPath(path, { external: true, reveal: native.action === "reveal" }) }] : []),
        { type: "separator" },
        { type: "item", id: "copy-path", label: "Copy path", onSelect: async () => {
          try {
            await navigator.clipboard.writeText(path)
          } catch {
            toast.error("Could not copy this path.")
          }
        } },
      ]}
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
      {native ? <button
        type="button"
        onClick={() => openArtifactPath(path, { external: true, reveal: native.action === "reveal" })}
        title={`${nativeLabel}: ${name}`}
        aria-label={`${nativeLabel}: ${name}`}
        className="flex cursor-pointer items-center pr-1.5 text-muted-foreground opacity-0 transition-opacity focus-visible:opacity-100 group-hover/chip:opacity-100 hover:text-foreground"
      >
        <ArrowUpRight aria-hidden="true" className="size-2.5" />
      </button> : null}
    </ActionContextMenu>
  )
}
