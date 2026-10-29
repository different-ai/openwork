import {
  desktopStartupFailureReasonSchema,
  type ConnectorCheckReason,
  type ConnectorCheckState,
  type DesktopStartupFailureReason,
  type DesktopStartupStep,
  type DiagnosticsAttention,
  type DiagnosticsAttentionCode,
  type DiagnosticsSectionId,
  type ProviderCheckReason,
  type ProviderCheckState,
} from "@openwork/types/den/diagnostics";
import {
  getPermissionDefinition,
  isPermissionKey,
  isPermissionOwnerOnlyByDefault,
} from "@openwork/types/den/permissions";
import type { ServiceReadinessState } from "@openwork/types/den/service-readiness";

/**
 * Every user-facing string on Settings › Diagnostics. Records are exhaustive
 * over the contract enums, so a new server code fails typecheck until it has
 * copy. Codes and enum values never reach the screen.
 */

export type DiagnosticsTone = "neutral" | "success" | "warning" | "danger";

export const DIAGNOSTICS_COPY = {
  title: "Diagnostics",
  copyReport: "Copy report",
  copied: "Copied",
  checkNow: "Check now",
  checking: "Checking",
  everythingWorking: "Everything is working",
  notCheckedYet: "Not checked yet",
  loadError: "Couldn't load diagnostics. The last results are kept. Try again in a moment.",
  checkError: "Couldn't start a check. Try again in a moment.",
  retry: "Try again",
  signedOut: "Your session ended. Sign in again to see diagnostics.",
  forbidden: "Diagnostics need an organization permission or installation admin access. Ask an organization owner or admin.",
  unsupported: "Diagnostics aren't available here. Reload the page, or update the OpenWork server if this keeps happening.",
  attentionList: "Needs attention",
  cooldown: (seconds: number) => `Check now is available again in ${seconds} s`,
} as const;

export function attentionCountLabel(count: number): string {
  return `${count} ${count === 1 ? "needs" : "need"} attention`;
}

export function checkedAgoLabel(ago: string | null): string {
  return ago ? `Checked ${ago}` : DIAGNOSTICS_COPY.notCheckedYet;
}

// ── Sections ───────────────────────────────────────────────────────────────

export const SECTION_TITLES: Record<DiagnosticsSectionId, string> = {
  desktop: "Desktop app",
  providers: "AI providers",
  connectors: "Connectors",
  installation: "Installation",
  network: "Advanced",
};

export const SECTION_SCOPES: Record<DiagnosticsSectionId, string | null> = {
  desktop: "Last 24 hours",
  providers: "Checked against each endpoint. No prompt sent.",
  connectors: null,
  installation: null,
  network: null,
};

export const INSTALLATION_COPY = {
  selfHosted: "Self-hosted",
  server: "OpenWork server",
  managed: "Managed by OpenWork",
  lockedName: "Installation admins only",
  lockedSub: "Ask whoever set up OpenWork for your organization",
} as const;

export const NETWORK_COPY = {
  name: "Network check",
  sub: "From the OpenWork server",
} as const;

/** "Requires permission to view desktop policies", from the catalog label, never the raw key. */
export function lockedSectionCopy(permission: string): { name: string; sub: string } {
  if (!isPermissionKey(permission)) return { name: "Requires an organization permission", sub: "Ask an organization owner or admin" };
  const label = getPermissionDefinition(permission).label;
  return {
    name: `Requires permission to ${label.charAt(0).toLowerCase()}${label.slice(1)}`,
    sub: isPermissionOwnerOnlyByDefault(permission) ? "Ask the organization owner" : "Ask an organization owner or admin",
  };
}

// ── Desktop app ────────────────────────────────────────────────────────────

export const DESKTOP_STEP_LABELS: Record<DesktopStartupStep, string> = {
  window: "Window open",
  engine: "Engine ready",
  signed_in: "Signed in to OpenWork",
  org_tools: "Org tools loaded",
};

/** Short phrase after "couldn't reach OpenWork:". */
export const DESKTOP_REASON_SHORT: Record<DesktopStartupFailureReason, string> = {
  certificate: "certificate not trusted",
  dns: "server name not found",
  offline: "device offline",
  timeout: "timed out",
  connection_refused: "connection refused",
  server_error: "server error",
  session_expired: "sign-in expired",
  signed_out: "signed out",
  engine_failed: "local engine didn't start",
  org_unavailable: "organization tools didn't load",
  unknown: "unknown error",
};

export const DESKTOP_REASON_BADGES: Record<DesktopStartupFailureReason, string> = {
  certificate: "Certificate",
  dns: "Server name",
  offline: "Offline",
  timeout: "Timed out",
  connection_refused: "Refused",
  server_error: "Server error",
  session_expired: "Sign-in expired",
  signed_out: "Signed out",
  engine_failed: "Engine",
  org_unavailable: "Org tools",
  unknown: "Unknown",
};

export const DESKTOP_REASON_DETAILS: Record<DesktopStartupFailureReason, string> = {
  certificate: "The device doesn't trust the server's certificate",
  dns: "The device couldn't find the server by name",
  offline: "The device had no network connection",
  timeout: "The server didn't answer in time",
  connection_refused: "The server refused the connection",
  server_error: "The server answered with an error",
  session_expired: "The person's sign-in had expired",
  signed_out: "The person was signed out",
  engine_failed: "The local engine on the device didn't start",
  org_unavailable: "The organization's tools didn't load",
  unknown: "The app couldn't tell what went wrong",
};

/** What to do next (DESIGN.md C6). */
export const DESKTOP_REASON_NEXT_STEPS: Record<DesktopStartupFailureReason, string> = {
  certificate: "Add your company's root certificate to these devices' system trust store",
  dns: "Check that these devices can resolve the server's address, including on VPN",
  offline: "Nothing to fix if these devices connected later",
  timeout: "Check the network path from these devices to the server, including proxies",
  connection_refused: "Check the server address and that it accepts connections from these devices",
  server_error: "Check the server logs around the last failure",
  session_expired: "Ask these people to sign in to OpenWork again",
  signed_out: "Ask these people to sign in to OpenWork again",
  engine_failed: "Ask these people to restart OpenWork, then share the app logs with support if it keeps failing",
  org_unavailable: "Check the organization's connectors and policies, then ask these people to restart OpenWork",
  unknown: "Ask these people to share the app logs with support",
};

export const DESKTOP_COPY = {
  summaryName: "Start to connected",
  failureName: "Failed to connect",
  failedToStart: "Failed to start",
  noStartups: "No startups reported",
  healthy: "Healthy",
  someFailed: "Some failed",
  notConnecting: "Not connecting",
  noData: "No data",
  versions: "Versions",
  people: "People",
  stoppedAt: "Stopped at",
  reason: "Reason",
  nextStep: "Next step",
  lastSeen: "Last seen",
  stepsLabel: "Time spent in each step",
} as const;

export function startupsLabel(count: number): string {
  return `${count} ${count === 1 ? "startup" : "startups"}`;
}

export function peopleLabel(count: number): string {
  return `${count} ${count === 1 ? "person" : "people"}`;
}

export function desktopReason(value: string | null): DesktopStartupFailureReason {
  const parsed = desktopStartupFailureReasonSchema.safeParse(value);
  return parsed.success ? parsed.data : "unknown";
}

// ── AI providers ───────────────────────────────────────────────────────────

export const PROVIDER_STATE_LABELS: Record<ProviderCheckState, string> = {
  ready: "Ready",
  key_rejected: "Key rejected",
  unreachable: "Unreachable",
  model_missing: "Model missing",
  misconfigured: "Misconfigured",
  member_credentials: "Member sign-in",
  managed: "Managed",
  not_checked: "Not checked",
};

export const PROVIDER_STATE_TONES: Record<ProviderCheckState, DiagnosticsTone> = {
  ready: "success",
  key_rejected: "danger",
  unreachable: "danger",
  model_missing: "warning",
  misconfigured: "warning",
  member_credentials: "neutral",
  managed: "neutral",
  not_checked: "neutral",
};

export const PROVIDER_REASON_COPY: Record<ProviderCheckReason, string> = {
  models_listed: "Listed models with the organization's key. No prompt sent.",
  key_accepted: "The key was accepted. Model access can't be listed without sending a request.",
  no_live_check: "This provider can't be checked without sending a prompt.",
  member_sign_in: "Each person signs in with their own account. Their sign-ins are never used for checks.",
  endpoint_not_found: "Nothing answered at the configured address.",
  network_error: "Couldn't connect to the endpoint.",
  timeout: "The endpoint didn't answer in time.",
  configuration_error: "The provider settings are incomplete or invalid.",
  credential_missing: "No organization key is saved for this provider.",
  sync_error: "The last model sync failed.",
  managed_by_openwork: "OpenWork runs this provider for you.",
  not_checked_yet: "Not checked yet.",
  credential_rejected: "The provider rejected the saved key.",
  credential_expired: "The saved credential expired and can't be refreshed.",
  unexpected_response: "The endpoint answered with an error. It may be rate limited or down.",
};

/** Next step for problem states (DESIGN.md C6); null when nothing needs doing. */
export const PROVIDER_NEXT_STEPS: Record<ProviderCheckState, string | null> = {
  ready: null,
  key_rejected: "Replace the API key in AI Gateway",
  unreachable: "Check the endpoint address and that the OpenWork server can reach it",
  model_missing: "Remove the missing models in AI Gateway or deploy them on the endpoint",
  misconfigured: "Review the provider settings in AI Gateway",
  member_credentials: null,
  managed: null,
  not_checked: null,
};

/** The row's one action (DESIGN.md S2); null when the row needs none. */
export const PROVIDER_ACTIONS: Record<ProviderCheckState, string | null> = {
  ready: null,
  key_rejected: "Update key",
  unreachable: "Edit provider",
  model_missing: "Fix models",
  misconfigured: "Fix settings",
  member_credentials: null,
  managed: null,
  not_checked: null,
};

export const PROVIDER_COPY = {
  empty: "No AI providers set up",
  addProvider: "Add a provider",
  managed: "Managed by OpenWork",
  result: "Result",
  endpointAnswered: "Endpoint answered",
  notServed: "Not served",
  notServedImpact: "People who pick it will get an error.",
  models: "Models",
  members: "Members",
  checked: "Checked",
  lastWorked: "Last worked",
  nextStep: "Next step",
  neverWorked: "No successful check yet",
} as const;

export function modelsLabel(available: number, configured: number): string {
  return configured > 0 ? `${available} of ${configured} models` : `${available} ${available === 1 ? "model" : "models"}`;
}

export function memberConnectionsLabel(connected: number, needsAttention: number): string {
  const people = `${connected} connected`;
  return needsAttention > 0 ? `${people}, ${needsAttention} ${needsAttention === 1 ? "needs" : "need"} to sign in again` : people;
}

// ── Connectors ─────────────────────────────────────────────────────────────

export const CONNECTOR_STATE_LABELS: Record<ConnectorCheckState, string> = {
  ready: "Connected",
  attention: "Needs attention",
  off: "Off",
  not_checked: "Not checked",
};

export const CONNECTOR_STATE_TONES: Record<ConnectorCheckState, DiagnosticsTone> = {
  ready: "success",
  attention: "warning",
  off: "neutral",
  not_checked: "neutral",
};

export const CONNECTOR_REASON_COPY: Record<ConnectorCheckReason, string> = {
  slack_token_accepted: "Slack accepted the token and permissions. Nothing was posted.",
  slack_token_rejected: "Slack rejected the token. Reinstall the Slack app to get a new one.",
  slack_not_installed: "The Slack app isn't installed in a workspace yet.",
  slack_assistant_off: "The Slack assistant is turned off.",
  slack_runner_missing: "No headless runner is set up, so the Slack assistant can't answer.",
  google_apis_enabled: "Every Google API this connector needs is turned on.",
  google_api_disabled: "Some Google APIs this connector needs are turned off in Google Cloud.",
  google_sign_in_required: "Sign in to Google Workspace to check which APIs are turned on.",
  not_checked_yet: "Not checked yet.",
};

export const CONNECTOR_ACTIONS: Record<ConnectorCheckReason, string | null> = {
  slack_token_accepted: null,
  slack_token_rejected: "Reconnect Slack",
  slack_not_installed: "Set up Slack",
  slack_assistant_off: null,
  slack_runner_missing: null,
  google_apis_enabled: null,
  google_api_disabled: null,
  google_sign_in_required: null,
  not_checked_yet: null,
};

export const CONNECTOR_COPY = {
  empty: "No connectors set up",
  addConnector: "Add a connector",
  checked: "Checked",
  lastChecked: "Last checked",
  answers: "Answers in the last 24 hours",
  apisOn: "Turned on",
  apisOff: "Turned off in Google Cloud",
  apisUnknown: "Couldn't check",
  noEvents: "No events in 7 days",
} as const;

export function lastEventLabel(ago: string): string {
  return `Last event ${ago}`;
}

// ── Installation services ──────────────────────────────────────────────────

export const SERVICE_STATE_TONES: Record<ServiceReadinessState, DiagnosticsTone> = {
  ready: "success",
  not_configured: "neutral",
  misconfigured: "warning",
  unreachable: "danger",
  unknown: "neutral",
};

export const SERVICE_DETAIL_COPY = {
  checked: "Checked",
  details: "Details",
  setup: "Setup",
  settings: "Settings",
  settingsPresent: "Present",
  settingsMissing: "Incomplete or not set up",
  missingSettings: "Missing setting names",
  dependencies: "Depends on",
  role: "Role",
  required: "Required",
  optional: "Optional",
  lastChecked: "Last checked",
  lastSuccess: "Last successful check",
  started: "Started",
  readyIn: "Ready in",
  version: "Version",
} as const;

// ── Attention summary ──────────────────────────────────────────────────────

export type AttentionCopy = { text: string; action: string };

function andMore(count: number | null): string {
  return count !== null && count > 1 ? ` and ${count - 1} more` : "";
}

const ATTENTION_COPY: Record<DiagnosticsAttentionCode, (item: DiagnosticsAttention) => AttentionCopy> = {
  provider_key_rejected: (item) => ({ text: `${item.subject} rejected the API key`, action: "Update key" }),
  provider_unreachable: (item) => ({ text: `Couldn't reach ${item.subject}`, action: "See details" }),
  provider_model_missing: (item) => ({
    text: item.detail
      ? `${item.subject} doesn't serve ${item.detail}${andMore(item.count)}`
      : `${item.subject} doesn't serve ${item.count ?? "some"} configured ${item.count === 1 ? "model" : "models"}`,
    action: "Fix models",
  }),
  provider_misconfigured: (item) => ({ text: `${item.subject} isn't set up correctly`, action: "Fix settings" }),
  desktop_startup_failures: (item) => {
    const count = item.count ?? 0;
    return {
      text: `${count} desktop ${count === 1 ? "startup" : "startups"} couldn't reach OpenWork: ${DESKTOP_REASON_SHORT[desktopReason(item.detail)]}`,
      action: "See details",
    };
  },
  connector_slack_token_rejected: (item) => ({ text: `Slack rejected the token for ${item.subject}`, action: "Reconnect Slack" }),
  connector_slack_not_installed: (item) => ({ text: `${item.subject} isn't installed in Slack`, action: "Set up Slack" }),
  connector_google_api_disabled: (item) => ({
    text: item.detail
      ? `${item.subject} needs ${item.detail}${andMore(item.count)} turned on in Google Cloud`
      : `${item.subject} needs Google APIs turned on in Google Cloud`,
    action: "See details",
  }),
  service_misconfigured: (item) => ({ text: `${item.subject} is misconfigured`, action: "See details" }),
  service_unreachable: (item) => ({ text: `Couldn't reach ${item.subject}`, action: "See details" }),
};

export function attentionCopy(item: DiagnosticsAttention): AttentionCopy {
  return ATTENTION_COPY[item.code](item);
}
