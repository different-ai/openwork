import type { Deployment } from "@openwork/license-contracts/modules"
import { gatewayBoolean } from "@openwork-ee/utils/gateway-env"

type Environment = Readonly<Record<string, string | undefined>>

export type OrgMode = "single_org" | "multi_org"

/**
 * Instance inputs of the legacy adapter (00-legacy-mapping §E.1). Built once
 * per process from each app's own parsed env.
 */
export interface InstanceConfig {
  readonly orgMode: OrgMode
  /** Infrastructure presence. `undefined` = not known in this process (see `availabilityObservable`). */
  readonly infra: {
    /** `GATEWAY_ENABLED` (`parseGatewayDeploymentEnv().enabled`). */
    readonly gatewayEnabled?: boolean
    /** den-api `headlessRunnerConfig() !== null`. */
    readonly headlessRunnerConfigured?: boolean
    /** `workbotOrigin() !== null` (`DEN_WORKBOT_URL`). */
    readonly workbotConfigured?: boolean
    /** den-api `cloudRuntimeAvailable()`: a cloud runtime provider with credentials. */
    readonly cloudRuntimeAvailable?: boolean
    /** `INFERENCE_FREE_ENABLED`. */
    readonly freeInferenceConfigured?: boolean
  }
  /** D19: feature env flags still honored for a few releases. Removed in Phase 6. */
  readonly deprecatedFlags: {
    /** `DEN_PLAN_GATING_ENABLED`. */
    readonly planGatingEnabled: boolean
    /** `DEN_AUTOMATIONS_RUNTIME_ENABLED ?? DEN_AUTOMATIONS_ENABLED ?? true`. */
    readonly automationsRuntimeEnabled: boolean
    /** `DEN_AUTOMATIONS_ENABLED` (desktop-config field only, never availability). */
    readonly automationsDesktopEnabled: boolean
    /** `DEN_APP_MCP_SERVERS_ENABLED`, default true. */
    readonly appMcpServersEnabled: boolean
    /** `DEN_DASHBOARDS_ENABLED` (desktop-config field only, Q-B14). */
    readonly dashboardsDesktopEnabled: boolean
    /** `DEN_OPENWORK_WEB_ENABLED`. */
    readonly openworkWebEnabled: boolean
    readonly auditCaptureEnabled: boolean
    readonly auditVisibilityEnabled: boolean
    readonly auditSelfHostedEnabled: boolean
    /** `DEN_SLACK_ASSISTANT_WORKER_ENABLED !== "false"` (job toggle, not a resolver input). */
    readonly slackAssistantWorkerEnabled: boolean
  }
}

/** den-api `parseBooleanFlag`: `1/true/yes/on`, case-insensitive. */
function booleanFlag(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on"
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

/** den-api `DEN_AUDIT_*`: the literal strings `true`/`false` only (zod enum). */
function auditFlag(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${name} must be true or false`)
}

/** den-api `parseDenOrgMode`. */
export function parseOrgMode(value: string | undefined): OrgMode {
  const normalized = value?.trim()
  if (!normalized || normalized === "single_org") return "single_org"
  if (normalized === "multi_org") return "multi_org"
  throw new Error("DEN_ORG_MODE must be single_org or multi_org")
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/** den-api `workbotOrigin() !== null`. */
function workbotConfigured(value: string | undefined): boolean {
  const raw = value?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))
  } catch {
    return false
  }
}

/** `@openwork/types` `readFreeInferenceConfig().enabled` (both apps validate the value at boot). */
function freeInferenceEnabled(value: string | undefined): boolean {
  return value === "true" || value === "1"
}

/**
 * Mirrors den-api's `env.ts` defaults for exactly these fields, for processes
 * that don't run den-api's env (the gateway). den-api builds the same object
 * from its parsed env (`instanceConfigFromDenEnv`, parity-tested). Fields this
 * process can't know (headless runner, cloud runtime credentials) stay
 * `undefined`.
 */
export function parseInstanceConfig(env: Environment): InstanceConfig {
  const automationsRuntimeEnabled = booleanFlag(env.DEN_AUTOMATIONS_RUNTIME_ENABLED ?? env.DEN_AUTOMATIONS_ENABLED ?? "true")
  return {
    orgMode: parseOrgMode(env.DEN_ORG_MODE),
    infra: {
      gatewayEnabled: gatewayBoolean(env.GATEWAY_ENABLED, "GATEWAY_ENABLED"),
      workbotConfigured: workbotConfigured(env.DEN_WORKBOT_URL),
      freeInferenceConfigured: freeInferenceEnabled(env.INFERENCE_FREE_ENABLED),
    },
    deprecatedFlags: {
      planGatingEnabled: (env.DEN_PLAN_GATING_ENABLED ?? "false").toLowerCase() === "true",
      automationsRuntimeEnabled,
      automationsDesktopEnabled: automationsRuntimeEnabled && booleanFlag(env.DEN_AUTOMATIONS_ENABLED ?? "false"),
      appMcpServersEnabled: booleanFlag(optionalString(env.DEN_APP_MCP_SERVERS_ENABLED) ?? "true"),
      dashboardsDesktopEnabled: booleanFlag(env.DEN_DASHBOARDS_ENABLED ?? "false"),
      openworkWebEnabled: booleanFlag(env.DEN_OPENWORK_WEB_ENABLED ?? "false"),
      auditCaptureEnabled: auditFlag(env.DEN_AUDIT_CAPTURE_ENABLED, "DEN_AUDIT_CAPTURE_ENABLED", true),
      auditVisibilityEnabled: auditFlag(env.DEN_AUDIT_VISIBILITY_ENABLED, "DEN_AUDIT_VISIBILITY_ENABLED", true),
      auditSelfHostedEnabled: auditFlag(env.DEN_AUDIT_SELF_HOSTED_ENABLED, "DEN_AUDIT_SELF_HOSTED_ENABLED", false),
      slackAssistantWorkerEnabled: env.DEN_SLACK_ASSISTANT_WORKER_ENABLED !== "false",
    },
  }
}

export const DEPLOYMENT_ENV = "DEN_DEPLOYMENT"

export type DeploymentSource = "explicit" | "derived"

/**
 * `DEN_DEPLOYMENT=cloud|self_hosted`. Unset: the legacy derivation
 * (`multi_org` → `cloud`, `single_org` → `selfHosted`), which matches today's
 * behavior because every Cloud-only legacy gate already needs `multi_org`.
 */
export function describeDeployment(env: Environment, orgMode: OrgMode): { deployment: Deployment; source: DeploymentSource } {
  const raw = env[DEPLOYMENT_ENV]?.trim()
  if (!raw) return { deployment: orgMode === "multi_org" ? "cloud" : "selfHosted", source: "derived" }
  if (raw === "cloud") return { deployment: "cloud", source: "explicit" }
  if (raw === "self_hosted") return { deployment: "selfHosted", source: "explicit" }
  throw new Error(`${DEPLOYMENT_ENV} must be cloud or self_hosted`)
}

export function resolveDeployment(env: Environment, orgMode: OrgMode): Deployment {
  return describeDeployment(env, orgMode).deployment
}
