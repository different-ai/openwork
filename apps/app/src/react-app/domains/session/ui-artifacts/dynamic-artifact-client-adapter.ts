import type { UiArtifactAttachment } from "@openwork/types/ui-artifact-project"

import type { OpenworkServerClient } from "@/app/lib/openwork-server"
import type { DynamicArtifactRendererHost } from "./dynamic-artifact-sandbox-frame"

export function createDynamicArtifactRendererHost(
  client: OpenworkServerClient,
  workspaceId: string,
  attachment: UiArtifactAttachment,
): DynamicArtifactRendererHost {
  return {
    load: async () => {
      const [build, state] = await Promise.all([
        client.getUiArtifactBuild(
          workspaceId,
          attachment.slug,
          attachment.projectRevision,
        ),
        client.getUiArtifactInstanceState(
          workspaceId,
          attachment.slug,
          attachment.instanceId,
        ),
      ])
      return { build, state }
    },
    replaceState: (update) => client.updateUiArtifactInstanceState(
      workspaceId,
      attachment.slug,
      attachment.instanceId,
      update,
    ),
    stageIntent: (request) => client.stageUiArtifactIntent(
      workspaceId,
      attachment.slug,
      attachment.instanceId,
      request,
    ),
  }
}
