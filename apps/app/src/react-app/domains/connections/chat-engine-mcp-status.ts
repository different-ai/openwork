import { mapV2McpStatuses } from "../../../app/lib/opencode-v2-adapter";
import type { McpStatusMap } from "../../../app/types";
import { OpenworkServerError, type EngineV2PreviewStatus, type OpenworkServerClient } from "../../../app/lib/openwork-server";

type StatusClient = Pick<OpenworkServerClient, "getMcpStatus" | "getChatEngineMcpCatalog"> & {
  getEngineV2PreviewStatus: () => Promise<Pick<EngineV2PreviewStatus, "enabled" | "chatRouting">>;
};

/**
 * Connection states as reported by the engine that runs chats.
 *
 * On a v2 desktop the older engine still answers status requests, and it
 * loads connections from the person's own OpenCode config that the chat
 * engine never registers. Asking it made Settings show "Connected" for a
 * connection no chat could use. A connection the chat engine does not know
 * has no entry here, which Settings shows as offline.
 */
export async function readChatEngineMcpStatus(client: StatusClient, workspaceId: string): Promise<McpStatusMap> {
  const v2 = await client.getEngineV2PreviewStatus().then(
    (status) => status.enabled && status.chatRouting,
    // An older server has no such route: it only has the one engine.
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
