import { getAllMcpConnectionRoute, getMcpConnectionRoute } from "../../_lib/den-org";
import type { ExternalMcpConnection } from "./mcp-connections-data";

/** An org sign-in nobody has finished, or a server still waiting on admin setup. */
export function connectorSetupUnfinished(connection: Pick<ExternalMcpConnection, "setupRequired" | "credentialMode" | "authType" | "connected">): boolean {
  if (connection.setupRequired) return true;
  return connection.credentialMode === "shared" && connection.authType !== "none" && !connection.connected;
}

/** Where Finish goes: the connector page to sign in, or the full editor when it needs an OAuth app or a key. */
export function finishSetupHref(orgSlug: string | null, connection: Pick<ExternalMcpConnection, "id" | "authType" | "oauthClientRequired" | "oauthClientConfigured">): string {
  const needsEditor = connection.authType !== "oauth" || (connection.oauthClientRequired === true && connection.oauthClientConfigured !== true);
  return needsEditor ? getAllMcpConnectionRoute(orgSlug, connection.id) : getMcpConnectionRoute(orgSlug, connection.id);
}

export function signInSentence(connection: Pick<ExternalMcpConnection, "name" | "authType" | "credentialMode">): string {
  if (connection.authType === "none") return "No sign-in needed";
  if (connection.authType === "apikey") return "Everyone uses the organization key";
  return connection.credentialMode === "per_member"
    ? `Each person signs in with their own ${connection.name} account`
    : `Everyone uses one ${connection.name} account`;
}
