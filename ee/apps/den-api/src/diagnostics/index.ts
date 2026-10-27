import {
  DIAGNOSTICS_SECTION_PERMISSIONS,
  type InstallationDiagnostics,
  type OrgDiagnostics,
  type ProviderCheck,
} from "@openwork/types/den/diagnostics"
import type { PermissionKey } from "@openwork/types/den/permissions"
import { createInferenceEgressFetch } from "@openwork-ee/utils/inference-egress"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import { env } from "../env.js"
import { gatewayManagementUnavailable } from "../gateway-deployment.js"
import { denServerFacts } from "../server-start.js"
import { currentDeploymentServices, deploymentServicesSnapshot, refreshDeploymentServices } from "../service-readiness-runtime.js"
import { checkRateLimit } from "../utils/rate-limit.js"
import { deriveDiagnosticsAttention } from "./attention.js"
import { checkGoogleConnectorForMember, checkSlackAssistantToken, loadConnectorTargets } from "./connectors.js"
import { desktopStartupDiagnostics } from "./desktop-startup.js"
import { emptyDesktopDiagnostics } from "./desktop-startup-summary.js"
import { checkOrganizationProviders } from "./providers.js"
import { createDiagnosticsRuntime, type RefreshAdmission } from "./runtime.js"

export type DiagnosticsCaller = {
  organizationId: DenTypeId<"organization">
  orgMembershipId: DenTypeId<"member">
  /** The caller's effective organization permissions (visibility only; no recent sign-in check). */
  has: (key: PermissionKey) => boolean
  /** Self-hosted installation operator (local allowlist), session or that operator's API key. */
  isInstallationOperator: () => Promise<boolean>
}

function logDiagnosticsError(scope: string, error: unknown) {
  // Names only: upstream errors may carry destinations or credentials.
  console.warn("[diagnostics]", scope, error instanceof Error ? error.name : typeof error)
}

export const diagnosticsRuntime = createDiagnosticsRuntime({
  now: Date.now,
  admit: (key, windowMs) => checkRateLimit(key, 1, windowMs, Date.now()),
  evaluateProviders: (organizationId, live, previousSuccess) => checkOrganizationProviders(normalizeDenTypeId("organization", organizationId), {
    live,
    fetchImpl: live ? createInferenceEgressFetch() : undefined,
    previousSuccess,
  }),
  loadConnectors: (organizationId) => loadConnectorTargets(normalizeDenTypeId("organization", organizationId)),
  checkSlack: (connectionId) => checkSlackAssistantToken(normalizeDenTypeId("externalMcpConnection", connectionId)),
  checkGoogle: (organizationId, orgMembershipId, target) => checkGoogleConnectorForMember({
    organizationId: normalizeDenTypeId("organization", organizationId),
    orgMembershipId: normalizeDenTypeId("member", orgMembershipId),
    target,
  }),
  onError: logDiagnosticsError,
})

type ProviderAccess = { granted: false; permission: PermissionKey } | { granted: true; include: (check: ProviderCheck) => boolean }

function providerAccess(caller: DiagnosticsCaller): ProviderAccess {
  const gatewayAvailable = !gatewayManagementUnavailable()
  const gateway = gatewayAvailable && caller.has(DIAGNOSTICS_SECTION_PERMISSIONS.providers)
  const legacy = caller.has("llm_providers.view")
  if (!gateway && !legacy) return { granted: false, permission: gatewayAvailable ? DIAGNOSTICS_SECTION_PERMISSIONS.providers : "llm_providers.view" }
  return { granted: true, include: (check) => check.source === "gateway" ? gateway : check.source === "legacy" ? legacy : true }
}

async function installationSection(caller: DiagnosticsCaller, refresh: boolean): Promise<InstallationDiagnostics> {
  if (env.features.deployment === "cloud") return { access: "managed" }
  const operator = await caller.isInstallationOperator().catch(() => false)
  if (!operator) return { access: "locked", reason: "installation_admin_required" }
  // After Check now, read without a second stale-while-revalidate admission.
  return { access: "operator", server: denServerFacts(), services: refresh ? deploymentServicesSnapshot() : currentDeploymentServices() }
}

async function section<T>(scope: string, compute: () => Promise<T>, fallback: () => T): Promise<T> {
  try {
    return await compute()
  } catch (error) {
    logDiagnosticsError(scope, error)
    return fallback()
  }
}

/**
 * Settings › Diagnostics for one caller. Each section is computed on its own
 * and degrades to its unchecked state on failure; nothing here waits for a
 * live check. With `refresh`, missing or expired live results start a
 * background check (rate limited).
 */
export async function readOrgDiagnostics(caller: DiagnosticsCaller, options: { refresh: boolean }): Promise<OrgDiagnostics> {
  const providers = providerAccess(caller)
  const [desktop, providerSection, connectorSection, installation] = await Promise.all([
    caller.has(DIAGNOSTICS_SECTION_PERMISSIONS.desktop)
      ? section("desktop", () => desktopStartupDiagnostics(caller.organizationId), emptyDesktopDiagnostics)
      : Promise.resolve({ access: "locked" as const, permission: DIAGNOSTICS_SECTION_PERMISSIONS.desktop }),
    providers.granted
      ? section("providers", () => diagnosticsRuntime.providers(caller.organizationId, { include: providers.include, refresh: options.refresh }),
        () => ({ access: "granted" as const, checkedAt: null, checking: false, items: [] }))
      : Promise.resolve({ access: "locked" as const, permission: providers.permission }),
    caller.has(DIAGNOSTICS_SECTION_PERMISSIONS.connectors)
      ? section("connectors", () => diagnosticsRuntime.connectors(caller.organizationId, caller.orgMembershipId, { refresh: options.refresh }),
        () => ({ access: "granted" as const, checkedAt: null, items: [], checking: false }))
      : Promise.resolve({ access: "locked" as const, permission: DIAGNOSTICS_SECTION_PERMISSIONS.connectors }),
    section("installation", () => installationSection(caller, options.refresh), (): InstallationDiagnostics => ({ access: "locked", reason: "installation_admin_required" })),
  ])
  const network = caller.has(DIAGNOSTICS_SECTION_PERMISSIONS.network)
    ? { access: "granted" as const, canRun: caller.has("egress_diagnostics.manage") }
    : { access: "locked" as const, permission: DIAGNOSTICS_SECTION_PERMISSIONS.network }
  const connectors = connectorSection.access === "granted"
    ? { access: connectorSection.access, checkedAt: connectorSection.checkedAt, items: connectorSection.items }
    : connectorSection
  const checking = (providerSection.access === "granted" && providerSection.checking)
    || (connectorSection.access === "granted" && connectorSection.checking)
    || (installation.access === "operator" && installation.services.checking)
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    deployment: env.features.deployment === "cloud" ? "cloud" : "self_hosted",
    checking,
    attention: deriveDiagnosticsAttention({ desktop, providers: providerSection, connectors, installation }),
    desktop,
    providers: providerSection,
    connectors,
    installation,
    network,
  }
}

/**
 * POST /v1/org/diagnostics/check: start every live check the caller may run.
 * `retryAfter` is set only when every requested check was rate limited.
 */
export async function checkOrgDiagnostics(caller: DiagnosticsCaller): Promise<{ diagnostics: OrgDiagnostics; retryAfter: number | null }> {
  const requested: Array<Promise<RefreshAdmission>> = []
  if (providerAccess(caller).granted) requested.push(diagnosticsRuntime.checkProviders(caller.organizationId))
  if (caller.has(DIAGNOSTICS_SECTION_PERMISSIONS.connectors)) requested.push(diagnosticsRuntime.checkConnectors(caller.organizationId, caller.orgMembershipId))
  if (env.features.deployment !== "cloud" && await caller.isInstallationOperator().catch(() => false)) {
    requested.push(refreshDeploymentServices().then((retryAfter) => retryAfter ?? "started"))
  }
  const admissions = (await Promise.allSettled(requested)).flatMap((result) => {
    if (result.status === "fulfilled") return result.value === "nothing_to_check" ? [] : [result.value]
    logDiagnosticsError("check", result.reason)
    return []
  })
  const limited = admissions.filter((admission): admission is number => typeof admission === "number")
  const retryAfter = admissions.length > 0 && limited.length === admissions.length ? Math.min(...limited) : null
  return { diagnostics: await readOrgDiagnostics(caller, { refresh: false }), retryAfter }
}
