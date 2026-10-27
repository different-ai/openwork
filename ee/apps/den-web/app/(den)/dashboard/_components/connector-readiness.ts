import type { ConnectionReadiness, ExternalMcpConnection } from "./mcp-connections-data";

export type ConnectorReadinessState = "Set up" | "Sign in" | "Checking…" | "Ready" | "Couldn't verify" | "Not checked";

export type ConnectorReadinessView = {
  /** Admin list: show the connector's own status rather than the signed-in member's. */
  organization?: boolean;
  /** A check for this connector is running right now. */
  checking?: boolean;
};

function readinessFor(connection: ExternalMcpConnection, view: ConnectorReadinessView): ConnectionReadiness | null | undefined {
  // Older servers have no connector-level status; fall back to the caller's own.
  return view.organization && connection.organizationReadiness !== undefined ? connection.organizationReadiness : connection.readiness;
}

function signInFailure(readiness: ConnectionReadiness | null | undefined) {
  return readiness?.status === "could_not_verify" && (readiness.failure === "sign_in_rejected" || readiness.failure === "sign_in_required");
}

/**
 * One status per connector row. Never checked is "Not checked", never
 * "Couldn't verify"; only a recorded check that did not pass is a failure,
 * and only a rejected or missing sign-in asks someone to sign in.
 */
export function connectorReadinessState(connection: ExternalMcpConnection, view: ConnectorReadinessView = {}): ConnectorReadinessState | null {
  const readiness = readinessFor(connection, view);
  if (readiness === undefined) return null;
  if (connection.setupRequired || connection.authTypeMismatch || connection.issuerReviewRequired
    || (connection.credentialMode === "shared" && !connection.connected)) return "Set up";
  if (connection.needsReconnect) return "Sign in";
  if (view.checking) return "Checking…";
  if (readiness?.status === "ready") return "Ready";
  if (signInFailure(readiness)) return "Sign in";
  if (connection.credentialMode === "per_member" && !connection.connectedForMe) return "Sign in";
  return readiness ? "Couldn't verify" : "Not checked";
}

function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" });
}

export function connectorReadinessNote(connection: ExternalMcpConnection, view: ConnectorReadinessView = {}) {
  const state = connectorReadinessState(connection, view);
  const readiness = readinessFor(connection, view);
  if (state === "Checking…") return "Checking that it connects and its tools can be read.";
  if (state === "Not checked") return "Not checked yet.";
  if (state === "Ready" && readiness) return `Checked ${formatTime(readiness.checkedAt)}`;
  if ((state === "Couldn't verify" || (state === "Sign in" && signInFailure(readiness))) && readiness) {
    const reason = readiness.reason ?? "The last check didn't pass.";
    return readiness.lastSuccessfulAt ? `${reason} Last ready ${formatTime(readiness.lastSuccessfulAt)}.` : reason;
  }
  return undefined;
}

/**
 * Admin list: which rows to bring up to date on page load. Only rows with no
 * stored status that someone could have checked: a connected shared
 * credential, or a per-member connector at least one person signed in to.
 */
export function connectorNeedsFirstCheck(connection: ExternalMcpConnection) {
  return connection.organizationReadiness === null
    && connectorReadinessState(connection, { organization: true }) !== "Set up"
    && connection.connected;
}
