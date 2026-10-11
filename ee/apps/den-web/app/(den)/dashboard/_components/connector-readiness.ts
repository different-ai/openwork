import type { ExternalMcpConnection } from "./mcp-connections-data";

export function connectorReadinessState(connection: ExternalMcpConnection) {
  if (connection.readiness === undefined) return null;
  if (connection.setupRequired || connection.authTypeMismatch || connection.issuerReviewRequired
    || (connection.credentialMode === "shared" && !connection.connected)) return "Set up";
  if (connection.needsReconnect || (connection.credentialMode === "per_member" && !connection.connectedForMe)) return "Sign in";
  return connection.readiness?.status === "ready" ? "Ready" : "Couldn't verify";
}

export function connectorReadinessNote(connection: ExternalMcpConnection) {
  const state = connectorReadinessState(connection);
  if (state === "Ready" && connection.readiness) {
    return `Checked ${new Date(connection.readiness.checkedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
  }
  if (state === "Couldn't verify") {
    const reason = connection.readiness?.reason ?? "Not checked yet.";
    const lastReady = connection.readiness?.lastSuccessfulAt;
    return lastReady ? `${reason} Last ready ${new Date(lastReady).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}.` : reason;
  }
  return undefined;
}
