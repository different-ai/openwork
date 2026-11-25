import type { DenConnectionReadinessFailure, DenExternalMcpConnection } from "../../../app/lib/den";

const PROVIDER_SETTINGS_PAGES: Record<string, string | null> = {
  "api.slack.com": "Open Slack app settings",
};

export type ProviderSettingsLink = { url: string; label: string };

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

export function providerSetupProblem(connection: ProblemConnection): ConnectionSignInProblem | null {
  const problem = problemFrom(connection);
  return problem?.failure === "provider_setup_required" ? problem : null;
}

export type ConnectAttempt = {
  startedAt: number;
  previousCheckedAt: string | null;
};

const CLOCK_SKEW_MS = 60_000;

export type ConnectPollOutcome =
  | { kind: "connected" }
  | { kind: "failed"; problem: ConnectionSignInProblem }
  | { kind: "waiting" };

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
