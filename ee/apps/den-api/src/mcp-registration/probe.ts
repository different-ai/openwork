import { discoverConnectionRequirements } from "@openwork/enterprise-mcp-client"
import type { McpRegistrationOutcome } from "@openwork/types/den/mcp-registration"
import { ALL_EXTERNAL_MCP_PRESETS, type ExternalMcpPreset } from "../capability-sources/external-mcp-presets.js"
import { externalMcpSharedCallbackUrl } from "../capability-sources/external-mcp-oauth-contract.js"
import { createGuardedFetch, createRealmSafeFetch } from "../capability-sources/url-guard.js"
import { env } from "../env.js"
import { appLogger } from "../observability/logger.js"
import { claimMcpRegistrationProbe, recordMcpRegistrationObservation } from "./status.js"

const logger = appLogger.child({ component: "mcp_registration_probe" })
const DISCOVERY_TIMEOUT_MS = 10_000
const REGISTRATION_TIMEOUT_MS = 10_000
const LEASE_MS = 10 * 60_000

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>

export type RegistrationAttempt = { outcome: McpRegistrationOutcome; httpStatus: number | null; diagnosticCode: string | null }

/**
 * Registers OpenWork with a provider exactly as a member's sign-in would (same client name, callback and grant types,
 * no secret), then deletes that registration when the provider allows it (RFC 7592). 401/403 means the provider only
 * accepts apps it approved; other failures are recorded without claiming a refusal.
 */
export async function attemptDynamicRegistration(input: {
  registrationEndpoint: string
  redirectUri: string
  scope?: string
  fetch: Fetch
}): Promise<RegistrationAttempt> {
  let response: Response
  try {
    response = await input.fetch(input.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        redirect_uris: [input.redirectUri],
        client_name: "OpenWork",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
        ...(input.scope ? { scope: input.scope } : {}),
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS),
    })
  } catch {
    return { outcome: "unreachable", httpStatus: null, diagnosticCode: "MCP_REGISTRATION_UNREACHABLE" }
  }
  const status = response.status
  if (response.ok) {
    const body: unknown = await response.json().catch(() => null)
    await deleteRegistration(body, input.fetch)
    return { outcome: "registered_dynamic", httpStatus: status, diagnosticCode: null }
  }
  await response.body?.cancel().catch(() => undefined)
  if (status === 401 || status === 403) return { outcome: "refused", httpStatus: status, diagnosticCode: `MCP_HTTP_${status}` }
  return { outcome: "metadata_only", httpStatus: status, diagnosticCode: `MCP_HTTP_${status}` }
}

async function deleteRegistration(body: unknown, fetchImpl: Fetch): Promise<void> {
  if (typeof body !== "object" || body === null) return
  const uri = "registration_client_uri" in body && typeof body.registration_client_uri === "string" ? body.registration_client_uri : null
  const token = "registration_access_token" in body && typeof body.registration_access_token === "string" ? body.registration_access_token : null
  if (!uri || !token) return
  await fetchImpl(uri, { method: "DELETE", headers: { authorization: `Bearer ${token}` }, redirect: "manual", signal: AbortSignal.timeout(REGISTRATION_TIMEOUT_MS) })
    .then((response) => response.body?.cancel())
    .catch(() => undefined)
}

type Discovered = {
  issuer: string
  authentication: "none" | "oauth"
  server: { issuer: string; registrationEndpoint?: string; clientIdMetadataDocumentSupported?: boolean } | null
}

/** What a preset's sign-in server advertises. Read-only; null when it cannot be reached or read. */
export async function discoverPreset(preset: ExternalMcpPreset, fetchImpl: Fetch): Promise<Discovered | null> {
  try {
    const requirements = await discoverConnectionRequirements({ serverUrl: preset.url, fetch: fetchImpl, timeoutMs: DISCOVERY_TIMEOUT_MS })
    if (requirements.authentication.kind === "none") {
      return { issuer: preset.authorizationServerIssuer ?? new URL(preset.url).origin, authentication: "none", server: null }
    }
    const server = requirements.authentication.authorizationServers[0]
    return server?.issuer ? { issuer: server.issuer, authentication: "oauth", server } : null
  } catch {
    return null
  }
}

/** Classifies one preset from its discovery and, where only a registration can tell, whether it accepts OpenWork. */
export async function probeMcpPresetRegistration(preset: ExternalMcpPreset, options: {
  fetch: Fetch
  redirectUri: string
  tryRegistration: boolean
  discovered: Discovered
}): Promise<{
  issuer: string
  outcome: McpRegistrationOutcome
  server: Discovered["server"]
  facts?: { clientMetadataSupported: boolean; dynamicRegistrationSupported: boolean }
  attempt: RegistrationAttempt | null
}> {
  const { discovered } = options
  if (discovered.authentication === "none" || !discovered.server) return { issuer: discovered.issuer, outcome: "no_auth", server: null, attempt: null }
  const server = discovered.server
  const facts = { clientMetadataSupported: server.clientIdMetadataDocumentSupported === true, dynamicRegistrationSupported: Boolean(server.registrationEndpoint) }
  if (preset.requiresOAuthClient || preset.defaultOAuthClientId || facts.clientMetadataSupported) {
    // CIMD needs no registration to learn from; a preset that requires an admin app is already labelled, and one with
    // OpenWork's own pre-registered app (defaultOAuthClientId) does not depend on registration at all.
    return { issuer: discovered.issuer, outcome: "metadata_only", server, facts, attempt: null }
  }
  if (!server.registrationEndpoint) return { issuer: discovered.issuer, outcome: "no_registration_method", server, facts, attempt: null }

  if (!options.tryRegistration) return { issuer: discovered.issuer, outcome: "metadata_only", server, facts, attempt: null }
  const attempt = await attemptDynamicRegistration({
    registrationEndpoint: server.registrationEndpoint,
    redirectUri: options.redirectUri,
    scope: preset.defaultOAuthScopes?.join(" "),
    fetch: options.fetch,
  })
  return { issuer: discovered.issuer, outcome: attempt.outcome, server, facts, attempt }
}

/**
 * One pass over every OAuth preset. Discovery is read-only; before anything is recorded or registered, the issuer is
 * claimed so replicas never check the same provider twice and a provider is checked at most once per interval.
 */
export async function runMcpRegistrationProbe(options: { tryRegistration?: boolean } = {}): Promise<{ checked: number; skipped: number }> {
  const fetchImpl = env.allowPrivateMcpUrls ? createRealmSafeFetch() : createGuardedFetch()
  const redirectUri = externalMcpSharedCallbackUrl()
  const tryRegistration = options.tryRegistration ?? env.mcpRegistrationProbe.tryRegistration
  let checked = 0
  let skipped = 0
  const seen = new Set<string>()
  for (const preset of ALL_EXTERNAL_MCP_PRESETS) {
    if (preset.authType !== "oauth" && !preset.supportedAuthTypes?.includes("oauth")) continue
    const discovered = await discoverPreset(preset, fetchImpl)
    if (!discovered) {
      logger.info("mcp_registration_probe_unreachable", { preset_id: preset.presetId })
      continue
    }
    if (seen.has(discovered.issuer) || !await claimMcpRegistrationProbe(discovered.issuer, LEASE_MS, env.mcpRegistrationProbe.intervalMs)) {
      skipped += 1
      continue
    }
    seen.add(discovered.issuer)
    const result = await probeMcpPresetRegistration(preset, { fetch: fetchImpl, redirectUri, tryRegistration, discovered })
    checked += 1
    await recordMcpRegistrationObservation({
      issuer: result.issuer,
      source: "probe",
      outcome: result.outcome,
      presetId: preset.presetId,
      serverUrl: preset.url,
      registrationEndpoint: result.server?.registrationEndpoint ?? null,
      ...(result.facts ?? {}),
      httpStatus: result.attempt?.httpStatus ?? null,
      diagnosticCode: result.attempt?.diagnosticCode ?? null,
    })
  }
  logger.info("mcp_registration_probe_completed", { checked, skipped, try_registration: tryRegistration })
  return { checked, skipped }
}

/** Runs the check on an interval when MCP_REGISTRATION_PROBE_ENABLED=1; returns a stop function. */
export function startMcpRegistrationProbeLoop(): () => Promise<void> {
  if (!env.mcpRegistrationProbe.enabled) return async () => undefined
  let running: Promise<unknown> | null = null
  const run = () => {
    if (running) return
    running = runMcpRegistrationProbe()
      .catch((error: unknown) => logger.warn("mcp_registration_probe_failed", { message: error instanceof Error ? error.message : String(error) }))
      .finally(() => { running = null })
  }
  // Stagger replicas so they rarely contend for the same lease.
  const first = setTimeout(run, 60_000 + Math.floor(Math.random() * 240_000))
  first.unref()
  const timer = setInterval(run, env.mcpRegistrationProbe.intervalMs)
  timer.unref()
  return async () => {
    clearTimeout(first)
    clearInterval(timer)
    await running
  }
}
