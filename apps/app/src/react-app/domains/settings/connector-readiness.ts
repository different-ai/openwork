import type { DenExternalMcpConnection } from "../../../app/lib/den";
import { providerSetupProblem } from "../connections/connection-sign-in-problem";

export type RecordedConnectorState = "Set up" | "Change setting" | "Sign in" | "Checking…" | "Ready" | "Couldn't verify" | "Not checked";

export type RecordedConnectorView = {
  checking?: boolean;
};

type Readiness = NonNullable<DenExternalMcpConnection["readiness"]>;

function signInFailure(readiness: Readiness | null | undefined) {
  return readiness?.status === "could_not_verify" && (readiness.failure === "sign_in_rejected" || readiness.failure === "sign_in_required");
}

/**
 * Mirrors Den web's connector-readiness: never checked is "Not checked", only
 * a recorded check that did not pass is "Couldn't verify", and only a
 * rejected or missing sign-in asks someone to sign in.
 */
export function recordedConnectorState(connection: DenExternalMcpConnection, view: RecordedConnectorView = {}): RecordedConnectorState | null {
  const readiness = connection.readiness;
  if (readiness === undefined) return null;
  if (connection.setupRequired || connection.issuerReviewRequired || (connection.credentialMode === "shared" && !connection.connected)) return "Set up";
  // Signing in again cannot work until the setting changes, so this wins over needsReconnect.
  if (providerSetupProblem(connection)) return "Change setting";
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

export function recordedConnectorNote(connection: DenExternalMcpConnection, view: RecordedConnectorView = {}) {
  const state = recordedConnectorState(connection, view);
  const readiness = connection.readiness;
  if (state === "Change setting") return providerSetupProblem(connection)?.reason ?? "";
  if (state === "Checking…") return "Checking that it connects and its tools can be read.";
  if (state === "Not checked") return "Not checked yet.";
  if (state === "Ready" && readiness) return `Checked ${formatTime(readiness.checkedAt)}`;
  if ((state === "Couldn't verify" || (state === "Sign in" && signInFailure(readiness))) && readiness) {
    const reason = readiness.reason ?? "The last check didn't pass.";
    return readiness.lastSuccessfulAt ? `${reason} Last ready ${formatTime(readiness.lastSuccessfulAt)}.` : reason;
  }
  if (state === "Sign in") return connection.credentialMode === "per_member" ? "Sign in to use and check this connection." : "An admin needs to reconnect this connection.";
  if (state === "Set up") return "An admin needs to finish setting this up.";
  return "";
}
