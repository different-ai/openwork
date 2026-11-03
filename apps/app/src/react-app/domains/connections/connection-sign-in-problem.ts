import type { DenConnectionReadinessFailure, DenExternalMcpConnection } from "../../../app/lib/den";

/**
 * Hosts whose settings pages Den may link to when a provider setting blocks
 * sign-in, and what the button calls that page. Anything else is not opened.
 */
const PROVIDER_SETTINGS_PAGES: Record<string, string | null> = {
  "api.slack.com": "Open Slack app settings",
};

export type ProviderSettingsLink = { url: string; label: string };

/** Only an https link to a known provider settings page is offered; the label never comes from the link. */
export function providerSettingsLink(value: unknown, connectionName: string): ProviderSettingsLink | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  if (!Object.hasOwn(PROVIDER_SETTINGS_PAGES, url.hostname)) return null;
  const label = PROVIDER_SETTINGS_PAGES[url.hostname] ?? `Open ${connectionName.trim() || "service"} settings`;
  return { url: url.toString(), label };
}

const FALLBACK_REASONS: Partial<Record<DenConnectionReadinessFailure, string>> = {
  provider_setup_required: "The service needs a setting changed before it can connect. Ask whoever manages the service's app to check its settings.",
  sign_in_rejected: "The service did not accept the sign-in. Try again.",
  sign_in_required: "Sign-in did not finish. Try again.",
};

export type ConnectionSignInProblem = {
  failure: DenConnectionReadinessFailure | null;
  /** Den's own sentence for what went wrong; provider text is never shown. */
  reason: string;
  settings: ProviderSettingsLink | null;
};

type ProblemConnection = Pick<DenExternalMcpConnection, "name" | "readiness">;

function problemFrom(connection: ProblemConnection): ConnectionSignInProblem | null {
  const readiness = connection.readiness;
  if (!readiness || readiness.status !== "could_not_verify") return null;
  const failure = readiness.failure ?? null;
  const reason = readiness.reason?.trim() || (failure ? FALLBACK_REASONS[failure] : undefined) || "The last sign-in did not connect. Try again.";
  return {
    failure,
    reason,
    settings: failure === "provider_setup_required" ? providerSettingsLink(readiness.providerSettingsUrl, connection.name) : null,
  };
}

/**
 * A setting in the service's own app blocks this member's sign-in. It wins
 * over needsReconnect: signing in again cannot work until the setting changes.
 */
export function providerSetupProblem(connection: ProblemConnection): ConnectionSignInProblem | null {
  const problem = problemFrom(connection);
  return problem?.failure === "provider_setup_required" ? problem : null;
}

export type ConnectAttempt = {
  /** Local clock when the member asked to sign in. */
  startedAt: number;
  /** The member's last recorded check before this attempt, so an old failure is not mistaken for this one. */
  previousCheckedAt: string | null;
};

/** Den's clock and this computer's can disagree a little. */
const CLOCK_SKEW_MS = 60_000;

export type ConnectPollOutcome =
  | { kind: "connected" }
  | { kind: "failed"; problem: ConnectionSignInProblem }
  | { kind: "waiting" };

/**
 * What one poll says about a sign-in in progress: connected, failed (Den
 * recorded a check for this member after the attempt started that did not
 * pass), or still waiting for the person to finish in the browser.
 */
export function connectPollOutcome(
  match: (ProblemConnection & Pick<DenExternalMcpConnection, "connectedForMe" | "connectedAt">) | undefined,
  attempt: ConnectAttempt,
  options: { previousConnectedAt: string | null; reconnectPending: boolean },
): ConnectPollOutcome {
  if (!match) return { kind: "waiting" };
  if (match.connectedForMe && !options.reconnectPending && typeof match.connectedAt === "string"
    && match.connectedAt.length > 0 && match.connectedAt !== options.previousConnectedAt) {
    return { kind: "connected" };
  }
  const readiness = match.readiness;
  if (!readiness || readiness.status !== "could_not_verify" || readiness.checkedAt === attempt.previousCheckedAt) return { kind: "waiting" };
  const checkedAt = Date.parse(readiness.checkedAt);
  if (!Number.isFinite(checkedAt) || checkedAt < attempt.startedAt - CLOCK_SKEW_MS) return { kind: "waiting" };
  const problem = problemFrom(match);
  return problem ? { kind: "failed", problem } : { kind: "waiting" };
}
