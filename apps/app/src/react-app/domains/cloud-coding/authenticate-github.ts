import type { DenClient } from "@/app/lib/den";
import { t } from "@/i18n";
import { CHAT_MCP_RECONNECT_POLL_INTERVAL_MS, CHAT_MCP_RECONNECT_TIMEOUT_MS } from "../session/surface/mcp-chat-reconnect";

export async function authenticateCloudCodingGitHub({ client, organizationId, isCurrent, onProgress, openUrl }: {
  client: Pick<DenClient, "getCloudCodingOverview" | "startCloudCodingGitHubLink">;
  organizationId: string;
  isCurrent: () => boolean;
  onProgress: (progress: { phase: "opening" } | { phase: "authorization_opened"; authorizeUrl: string }) => void;
  openUrl: (url: string) => Promise<void>;
}): Promise<"connected"> {
  const checkCurrent = () => {
    if (!isCurrent()) throw new Error(t("cloud_coding.link_changed"));
  };
  checkCurrent();
  onProgress({ phase: "opening" });
  const overview = await client.getCloudCodingOverview(organizationId);
  checkCurrent();
  if (overview.me.github) return "connected";
  const { redirectUrl } = await client.startCloudCodingGitHubLink(organizationId);
  checkCurrent();
  await openUrl(redirectUrl);
  checkCurrent();
  onProgress({ phase: "authorization_opened", authorizeUrl: redirectUrl });
  const deadline = Date.now() + CHAT_MCP_RECONNECT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise(resolve => window.setTimeout(resolve, CHAT_MCP_RECONNECT_POLL_INTERVAL_MS));
    checkCurrent();
    if (Date.now() >= deadline) break;
    const refreshed = await client.getCloudCodingOverview(organizationId).catch(() => null);
    checkCurrent();
    if (refreshed?.me.github) return "connected";
  }
  throw new Error(t("cloud_coding.link_unfinished"));
}
