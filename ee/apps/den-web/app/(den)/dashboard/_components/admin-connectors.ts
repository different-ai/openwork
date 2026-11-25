import { getMcpConnectionRoute } from "../../_lib/den-org";
import type { ExternalMcpConnection } from "./mcp-connections-data";

export function connectorSetupUnfinished(connection: Pick<ExternalMcpConnection, "setupRequired" | "credentialMode" | "authType" | "connected">): boolean {
  if (connection.setupRequired) return true;
  return connection.credentialMode === "shared" && connection.authType !== "none" && !connection.connected;
}

export function finishSetupHref(orgSlug: string | null, connection: Pick<ExternalMcpConnection, "id">): string {
  return getMcpConnectionRoute(orgSlug, connection.id);
}

export function signInSentence(connection: Pick<ExternalMcpConnection, "name" | "authType" | "credentialMode">): string {
  if (connection.authType === "none") return "No sign-in needed";
  if (connection.authType === "apikey") return connection.credentialMode === "per_member"
    ? "Each person adds their own key"
    : "Everyone uses the organization key";
  return connection.credentialMode === "per_member"
    ? `Each person signs in with their own ${connection.name} account`
    : `Everyone uses one ${connection.name} account`;
}
