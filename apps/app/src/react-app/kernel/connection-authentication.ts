import type { DenClient } from "@/app/lib/den";
import type { ChatToolReconnectProgress, ChatToolReconnectResult } from "@/components/tools/error-attribution";

export const CHAT_MCP_RECONNECT_POLL_INTERVAL_MS = 2_000;
export const CHAT_MCP_RECONNECT_TIMEOUT_MS = 3 * 60_000;

export type ConnectionAuthentication = {
  enabled: boolean;
  authenticate: (input: {
    client: DenClient;
    baseUrl: string;
    organizationId: string;
    isCurrent: () => boolean;
    onProgress: (progress: ChatToolReconnectProgress) => void;
    openUrl: (url: string) => Promise<void>;
  }) => Promise<ChatToolReconnectResult>;
};
