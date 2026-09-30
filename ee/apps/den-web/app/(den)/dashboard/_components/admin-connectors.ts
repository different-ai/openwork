import { getMcpConnectionRoute } from "../../_lib/den-org";
import type { ExternalMcpConnection } from "./mcp-connections-data";

/** An org sign-in nobody has finished, or a server still waiting on admin setup. */
export function connectorSetupUnfinished(connection: Pick<ExternalMcpConnection, "setupRequired" | "credentialMode" | "authType" | "connected">): boolean {
  if (connection.setupRequired) return true;
  return connection.credentialMode === "shared" && connection.authType !== "none" && !connection.connected;
}

/** Where Finish goes: the connector page, where an admin signs in or adds the key or OAuth app it still needs. */
export function finishSetupHref(orgSlug: string | null, connection: Pick<ExternalMcpConnection, "id">): string {
  return getMcpConnectionRoute(orgSlug, connection.id);
}

export function signInSentence(connection: Pick<ExternalMcpConnection, "name" | "authType" | "credentialMode">): string {
  if (connection.authType === "none") return "No sign-in needed";
  if (connection.authType === "apikey") return "Everyone uses the organization key";
  return connection.credentialMode === "per_member"
    ? `Each person signs in with their own ${connection.name} account`
    : `Everyone uses one ${connection.name} account`;
}
