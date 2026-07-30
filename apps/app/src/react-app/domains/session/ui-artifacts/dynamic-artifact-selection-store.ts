import { create } from "zustand"
import type { UiArtifactAttachment } from "@openwork/types/ui-artifact-project"

type DynamicArtifactSelection = {
  attachment?: UiArtifactAttachment
  workspaceId: string
  slug: string
}

type DynamicArtifactSelectionStore = {
  selection: DynamicArtifactSelection | null
  attachments: Record<string, UiArtifactAttachment>
  rememberAttachment: (attachment: UiArtifactAttachment) => void
  selectProject: (selection: DynamicArtifactSelection) => void
  clearSelection: (workspaceId: string) => void
}

function attachmentKey(workspaceId: string, slug: string) {
  return `${workspaceId}\u0000${slug}`
}

export const useDynamicArtifactSelectionStore = create<DynamicArtifactSelectionStore>((set) => ({
  selection: null,
  attachments: {},
  rememberAttachment: (attachment) => set((state) => ({
    attachments: {
      ...state.attachments,
      [attachmentKey(attachment.workspaceId, attachment.slug)]: attachment,
    },
  })),
  selectProject: (selection) => set((state) => {
    const attachment = selection.attachment
      ?? state.attachments[attachmentKey(selection.workspaceId, selection.slug)]
    return {
      attachments: attachment
        ? {
            ...state.attachments,
            [attachmentKey(selection.workspaceId, selection.slug)]: attachment,
          }
        : state.attachments,
      selection: {
        ...selection,
        attachment,
      },
    }
  }),
  clearSelection: (workspaceId) => set((state) => (
    state.selection?.workspaceId === workspaceId ? { selection: null } : state
  )),
}))
