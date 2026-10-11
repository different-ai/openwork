import type { DenExternalMcpConnection } from "../../../app/lib/den";

export function recordedConnectorState(connection: DenExternalMcpConnection) {
  if (connection.readiness === undefined) return null;
  if (connection.setupRequired || connection.issuerReviewRequired || (connection.credentialMode === "shared" && !connection.connected)) return "Set up";
  if (connection.needsReconnect || (connection.credentialMode === "per_member" && !connection.connectedForMe)) return "Sign in";
  return connection.readiness?.status === "ready" ? "Ready" : "Couldn't verify";
}

export function recordedConnectorNote(connection: DenExternalMcpConnection) {
  if (recordedConnectorState(connection) === "Ready" && connection.readiness) {
    return `Checked ${new Date(connection.readiness.checkedAt).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}`;
  }
  const reason = connection.readiness?.reason ?? "Not checked yet.";
  const lastReady = connection.readiness?.lastSuccessfulAt;
  return lastReady ? `${reason} Last ready ${new Date(lastReady).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}.` : reason;
}
