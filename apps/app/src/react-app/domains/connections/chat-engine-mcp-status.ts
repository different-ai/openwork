import { mapV2McpStatuses } from "../../../app/lib/opencode-v2-adapter";
import type { McpStatusMap } from "../../../app/types";
import { OpenworkServerError, type EngineV2PreviewStatus, type OpenworkServerClient } from "../../../app/lib/openwork-server";

type StatusClient = Pick<OpenworkServerClient, "getMcpStatus" | "getChatEngineMcpCatalog"> & {
  getEngineV2PreviewStatus: () => Promise<Pick<EngineV2PreviewStatus, "enabled" | "chatRouting">>;
};

export async function readChatEngineMcpStatus(client: StatusClient, workspaceId: string): Promise<McpStatusMap> {
  const v2 = await client.getEngineV2PreviewStatus().then(
    (status) => status.enabled && status.chatRouting,
    (error: unknown) => {
      if (error instanceof OpenworkServerError && error.status === 404) return false;
      throw error;
    },
  );
  if (!v2) return client.getMcpStatus(workspaceId);
  const statuses = mapV2McpStatuses(await client.getChatEngineMcpCatalog(workspaceId));
  if (!statuses) throw new Error("The chat engine returned an unreadable connection list.");
  return statuses;
}
