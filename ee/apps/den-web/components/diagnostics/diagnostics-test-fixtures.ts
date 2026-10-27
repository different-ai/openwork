import type { OrgDiagnostics, ProviderCheck } from "@openwork/types/den/diagnostics";
import type { DeploymentServiceReadiness } from "@openwork/types/den/service-readiness";

/** Shared report fixtures for the diagnostics unit tests. */

export const NOW = Date.parse("2026-10-20T16:00:00.000Z");
export const TWO_MIN_AGO = "2026-10-20T15:58:00.000Z";
export const TWO_DAYS_AGO = "2026-10-18T16:00:00.000Z";

export function provider(overrides: Partial<ProviderCheck> = {}): ProviderCheck {
  return {
    id: "gateway:anthropic:default", source: "gateway", providerId: "anthropic", name: "Anthropic", credentialName: null,
    state: "ready", reason: "models_listed", httpStatus: 200, durationMs: 180, checkedAt: TWO_MIN_AGO, lastSuccessAt: TWO_MIN_AGO,
    models: { configured: 3, served: 40, missing: [] }, members: null,
    ...overrides,
  };
}

export function services(): DeploymentServiceReadiness {
  return {
    version: 2, checkedAt: TWO_MIN_AGO, checking: false,
    server: { version: "0.19.2", startedAt: "2026-10-20T13:00:00.000Z", startupMs: 4_100 },
    services: [
      { id: "database", required: true, configured: true, state: "ready", reason: "database_verified", missingSettings: [], dependencies: [], notes: [], durationMs: 3, checkedAt: TWO_MIN_AGO, lastSuccessAt: TWO_MIN_AGO, stale: false },
      { id: "gateway", required: false, configured: true, state: "ready", reason: "health_verified", missingSettings: [], dependencies: [], notes: [], durationMs: 41, checkedAt: TWO_MIN_AGO, lastSuccessAt: TWO_MIN_AGO, stale: false },
      { id: "headlessRunner", required: false, configured: false, state: "not_configured", reason: "not_configured", missingSettings: ["DEN_HEADLESS_RUNNER_URL"], dependencies: [], notes: ["resume_not_configured"], durationMs: null, checkedAt: TWO_MIN_AGO, lastSuccessAt: null, stale: false },
      { id: "workbot", required: false, configured: true, state: "unreachable", reason: "request_failed", missingSettings: [], dependencies: ["headlessRunner"], notes: [], durationMs: 5_000, checkedAt: TWO_MIN_AGO, lastSuccessAt: TWO_DAYS_AGO, stale: false },
      { id: "email", required: false, configured: true, state: "ready", reason: "email_verified", missingSettings: [], dependencies: [], notes: ["email_smtp"], durationMs: 220, checkedAt: TWO_MIN_AGO, lastSuccessAt: TWO_MIN_AGO, stale: false },
    ],
  };
}

export function report(overrides: Partial<OrgDiagnostics> = {}): OrgDiagnostics {
  return {
    version: 1,
    generatedAt: "2026-10-20T16:00:00.000Z",
    deployment: "self_hosted",
    checking: false,
    attention: [
      { section: "desktop", targetId: "signed_in", severity: "warning", code: "desktop_startup_failures", subject: "Desktop app", count: 3, detail: "certificate" },
      { section: "providers", targetId: "gateway:litellm:default", severity: "error", code: "provider_key_rejected", subject: "LiteLLM", count: null, detail: null },
      { section: "providers", targetId: "gateway:bedrock:default", severity: "warning", code: "provider_model_missing", subject: "Amazon Bedrock", count: 1, detail: "claude-opus-5" },
    ],
    desktop: {
      access: "granted", windowHours: 24, startups: 142, connected: 139, failed: 3, people: 41, typicalMs: 1_800, slowestMs: 4_200,
      steps: [
        { step: "window", typicalMs: 600 }, { step: "engine", typicalMs: 500 },
        { step: "signed_in", typicalMs: 500 }, { step: "org_tools", typicalMs: 200 },
      ],
      failures: [{ step: "signed_in", reason: "certificate", count: 3, people: 3, lastSeenAt: "2026-10-20T15:42:00.000Z" }],
      versions: [{ version: "0.19.2", startups: 138 }, { version: "0.18.7", startups: 4 }],
    },
    providers: {
      access: "granted", checkedAt: TWO_MIN_AGO, checking: false,
      items: [
        provider({ id: "openwork", source: "openwork", providerId: "openwork", name: "OpenWork Models", state: "managed", reason: "managed_by_openwork", httpStatus: null, durationMs: null, models: { configured: 0, served: null, missing: [] } }),
        provider(),
        provider({ id: "gateway:bedrock:default", providerId: "amazon-bedrock", name: "Amazon Bedrock", state: "model_missing", reason: "models_listed", durationMs: 340, models: { configured: 3, served: 30, missing: ["claude-opus-5"] } }),
        provider({ id: "gateway:litellm:default", providerId: "litellm", name: "LiteLLM", credentialName: "Custom endpoint", state: "key_rejected", reason: "credential_rejected", httpStatus: 401, lastSuccessAt: TWO_DAYS_AGO, models: { configured: 2, served: null, missing: [] } }),
      ],
    },
    connectors: {
      access: "granted", checkedAt: TWO_MIN_AGO,
      items: [
        { id: "slack", kind: "slack_assistant", name: "Slack assistant", state: "ready", reason: "slack_token_accepted", checkedAt: TWO_MIN_AGO, lastEventAt: "2026-10-20T15:56:00.000Z", completed24h: 12, apis: [] },
        {
          id: "google", kind: "google_workspace", name: "Google Workspace", state: "ready", reason: "google_apis_enabled", checkedAt: TWO_MIN_AGO, lastEventAt: null, completed24h: null,
          apis: [{ id: "gmail", name: "Gmail", status: "enabled" }, { id: "calendar", name: "Calendar", status: "enabled" }, { id: "sheets", name: "Sheets", status: "disabled" }],
        },
      ],
    },
    installation: { access: "operator", server: { version: "0.19.2", startedAt: "2026-10-20T13:00:00.000Z", startupMs: 4_100 }, services: services() },
    network: { access: "granted", canRun: true },
    ...overrides,
  };
}

/** Everything locked except what a member with no organization permissions on Cloud sees. */
export function lockedReport(overrides: Partial<OrgDiagnostics> = {}): OrgDiagnostics {
  return report({
    deployment: "cloud",
    attention: [],
    desktop: { access: "locked", permission: "desktop_policies.view" },
    providers: { access: "locked", permission: "gateway_providers.view" },
    connectors: { access: "locked", permission: "connections.view" },
    installation: { access: "managed" },
    network: { access: "locked", permission: "egress_diagnostics.view" },
    ...overrides,
  });
}
