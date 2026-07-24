/** @jsxImportSource react */

import type { UIMessage } from "ai";
import { ArrowUpRightIcon } from "lucide-react";

import { ArtifactIcon } from "@/components/chat/artifact-icon";
import {
  type ArtifactItem,
  canOpenArtifact,
  canPreviewArtifact,
  useArtifacts,
  usePreviewArtifact,
} from "@/lib/artifacts";
import { useOpenTargets } from "@/lib/target-provider";

interface ArtifactChipProps {
  artifact: ArtifactItem
}

/**
 * Paper "File paths → chips · artifact strip": one chip per artifact —
 * type icon + name, full path in the tooltip. Click opens the artifact
 * preview; ↗ opens in the default app.
 */
function ArtifactChip({ artifact }: ArtifactChipProps) {
  const previewArtifact = usePreviewArtifact();
  const { onOpenTarget } = useOpenTargets();
  const canOpen = canOpenArtifact(artifact);
  const canPreview = canPreviewArtifact(artifact);

  return (
    <span className="inline-flex shrink-0 items-stretch overflow-hidden rounded-lg border border-border/70 bg-muted/40 align-middle">
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => previewArtifact(artifact)}
        title={canPreview ? `Preview ${artifact.path}` : `Open ${artifact.path}`}
        className="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 transition-colors hover:bg-muted disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ArtifactIcon className="size-3.5 shrink-0 text-muted-foreground" type={artifact.type} />
        <span className="max-w-40 truncate text-[13px] font-medium leading-4 text-foreground" title={artifact.name}>
          {artifact.name}
        </span>
      </button>
      {canOpen ? (
        <button
          type="button"
          onClick={() => onOpenTarget?.(artifact.legacy_target, { external: true })}
          title={`Open ${artifact.name} in default app`}
          aria-label={`Open ${artifact.name} in default app`}
          className="flex cursor-pointer items-center border-l border-border/60 px-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ArrowUpRightIcon aria-hidden="true" className="size-3" />
        </button>
      ) : null}
    </span>
  );
}

interface ArtifactListProps {
  messages: UIMessage[]
  includeTargetFallbacks?: boolean
}

/**
 * Paper artifact strip: a turn that touched files ends with a "FILES"
 * row of deduped chips — one place to open everything it produced.
 */
export function ArtifactList({ messages, includeTargetFallbacks = false }: ArtifactListProps) {
  const artifacts = useArtifacts(messages, { includeTargetFallbacks });

  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2 md:px-10" data-files-strip>
      <div className="no-scrollbar flex min-w-0 flex-nowrap items-center gap-2.5 overflow-x-auto pb-1">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground/80">
          Files
        </span>
        {artifacts.map((artifact) => (
          <ArtifactChip key={artifact.id} artifact={artifact} />
        ))}
      </div>
    </div>
  );
}
