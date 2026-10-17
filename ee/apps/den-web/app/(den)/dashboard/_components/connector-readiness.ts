import { deriveConnectionState, type ConnectionReadinessState } from "@openwork/types/den/connection-state";
import type { ExternalMcpConnection } from "./mcp-connections-data";

const readinessLabels = {
  needs_admin_setup: "Set up",
  needs_signin: "Sign in",
  ready: "Ready",
  could_not_verify: "Couldn't verify",
} as const satisfies Record<ConnectionReadinessState, string>;

export function connectorReadinessState(connection: ExternalMcpConnection) {
  const readiness = deriveConnectionState(connection).readiness;
  return readiness === null ? null : readinessLabels[readiness];
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
