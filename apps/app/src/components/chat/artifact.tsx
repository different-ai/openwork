/** @jsxImportSource react */

import type { UIMessage } from "ai";
import { ArrowUpRightIcon } from "lucide-react";

import { ArtifactIcon } from "@/components/chat/artifact-icon";
import {
  DescriptiveButton,
  DescriptiveButtonContent,
  DescriptiveButtonDescription,
  DescriptiveButtonIcon,
  DescriptiveButtonTitle,
} from "@/components/descriptive-button";
import {
  type ArtifactItem,
  getArtifactTypeLabel,
  useArtifacts,
  usePreviewArtifact,
} from "@/lib/artifacts";

interface ArtifactButtonProps {
  artifact: ArtifactItem
}

function ArtifactButton({ artifact }: ArtifactButtonProps) {
  const previewArtifact = usePreviewArtifact();

  return (
    <DescriptiveButton
      className="px-2 py-1 items-center gap-2"
      onClick={() => previewArtifact(artifact)}
    >
      <DescriptiveButtonIcon>
        <ArtifactIcon className="size-6 shrink-0" type={artifact.type} />
      </DescriptiveButtonIcon>
      <DescriptiveButtonContent className="gap-0">
        <DescriptiveButtonTitle>{artifact.name}</DescriptiveButtonTitle>
        <DescriptiveButtonDescription className="text-xs">
          {getArtifactTypeLabel(artifact.type)}
        </DescriptiveButtonDescription>
      </DescriptiveButtonContent>
      <ArrowUpRightIcon className="size-4 shrink-0 text-muted-foreground me-2" />
    </DescriptiveButton>
  );
}

interface ArtifactListProps {
  messages: UIMessage[]
}

export function ArtifactList({ messages }: ArtifactListProps) {
  const artifacts = useArtifacts(messages);

  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-2 md:px-10">
      <div className="grid min-w-0 gap-2 @xl/message-list:grid-cols-2">
        {artifacts.map((artifact) => (
          <ArtifactButton key={artifact.id} artifact={artifact} />
        ))}
      </div>
    </div>
  );
}
