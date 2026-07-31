import { randomUUID } from "node:crypto"
import { Buffer } from "node:buffer"
import { normalizeDenTypeId, type DenTypeId } from "@openwork-ee/utils/typeid"
import {
  getCliConnector,
  listEnabledCliConnectors,
} from "../capability-sources/cli-connections.js"
import { getCliConnectorManifest } from "../capability-sources/cli-connector-manifests.js"
import {
  CliRunnerExecutionError,
  CliRunnerUnavailableError,
  daytonaCliRunner,
  type CliVersionProbeRunner,
} from "../cli-runner/daytona-cli-runner.js"
import { appLogger } from "../observability/logger.js"
import type { McpMemberIdentity } from "./external-capabilities.js"
import {
  scoreText,
  tokenize,
  type CapabilityMatch,
} from "./search.js"

const CLI_CAPABILITY_PREFIX = "cli:"
const logger = appLogger.child({ component: "cli_capabilities" })

export type CliCapabilityStore = {
  listEnabledCliConnectors: typeof listEnabledCliConnectors
  getCliConnector: typeof getCliConnector
}

const cliCapabilityStore: CliCapabilityStore = {
  listEnabledCliConnectors,
  getCliConnector,
}

export type CliCapabilityMatch = CapabilityMatch & {
  risk: "read"
  schemaDigest: string
  manifestDigest: string
}

export type CliCapabilityExecuteResult =
  | {
    ok: true
    result: {
      kind: "cli_execution"
      capability: string
      connector: { id: string; catalogKey: string; name: string }
      command: "version"
      risk: "read"
      manifestVersion: string
      manifestDigest: string
      exitCode: number
      stdout: string
      stderr: string
      durationMs: number
      referenceId: string
    }
  }
  | {
    ok: false
    error: "unknown_capability" | "forbidden" | "connector_not_ready" | "invalid_capability_arguments" | "runner_unavailable" | "execution_failed"
    message: string
    referenceId?: string
  }

export function buildCliCapabilityName(connectionId: string, commandId: string): string {
  return `${CLI_CAPABILITY_PREFIX}${connectionId}:${commandId}`
}

export function parseCliCapabilityName(name: string): { connectionId: string; commandId: string } | null {
  if (!name.startsWith(CLI_CAPABILITY_PREFIX)) return null
  const value = name.slice(CLI_CAPABILITY_PREFIX.length)
  const separatorIndex = value.indexOf(":")
  if (separatorIndex <= 0 || separatorIndex === value.length - 1) return null
  if (value.indexOf(":", separatorIndex + 1) !== -1) return null
  return {
    connectionId: value.slice(0, separatorIndex),
    commandId: value.slice(separatorIndex + 1),
  }
}

export async function searchCliCapabilitiesWithStore(input: {
  organizationId: string
  member: McpMemberIdentity | null
  query: string
  limit: number
  enabled: boolean
}, store: CliCapabilityStore): Promise<CliCapabilityMatch[]> {
  if (!input.enabled || !input.member) return []
  const organizationId = normalizeDenTypeId("organization", input.organizationId)
  const queryTokens = tokenize(input.query)
  if (queryTokens.length === 0) return []
  const connections = await store.listEnabledCliConnectors(organizationId)
  const matches: CliCapabilityMatch[] = []

  for (const connection of connections) {
    const manifest = getCliConnectorManifest(connection.catalogKey, connection.manifestVersion)
    if (!manifest) continue
    const command = manifest.commands.version
    const score = scoreText(
      tokenize(`${connection.name} github gh version`),
      tokenize(command.description),
      queryTokens,
    )
    if (score <= 0) continue
    matches.push({
      name: buildCliCapabilityName(connection.id, command.id),
      method: "CLI",
      path: `cli://${manifest.catalogKey}/${command.id}`,
      score,
      summary: `[${connection.name}] ${command.description}`,
      pathParams: [],
      queryParams: [],
      hasBody: false,
      risk: command.risk,
      schemaDigest: manifest.digest,
      manifestDigest: manifest.digest,
    })
  }

  return matches
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
    .slice(0, Math.max(0, input.limit))
}

export function searchCliCapabilities(
  input: Parameters<typeof searchCliCapabilitiesWithStore>[0],
): Promise<CliCapabilityMatch[]> {
  return searchCliCapabilitiesWithStore(input, cliCapabilityStore)
}

function hasUnsupportedBody(body: unknown): boolean {
  if (body === undefined || body === null) return false
  if (typeof body !== "object" || Array.isArray(body)) return true
  return Object.keys(body).length > 0
}

export async function executeCliCapabilityWithRunner(input: {
  organizationId: string
  member: McpMemberIdentity | null
  connectionId: string
  commandId: string
  body: unknown
  schemaDigest?: string
  enabled: boolean
}, runner: CliVersionProbeRunner, store: CliCapabilityStore = cliCapabilityStore): Promise<CliCapabilityExecuteResult> {
  if (!input.enabled) {
    return { ok: false, error: "unknown_capability", message: "No CLI connector capabilities are available for this organization." }
  }
  if (!input.member) {
    return { ok: false, error: "forbidden", message: "No active organization membership exists for this token." }
  }
  if (input.commandId !== "version") {
    return { ok: false, error: "unknown_capability", message: "The requested CLI command is not available." }
  }
  if (hasUnsupportedBody(input.body)) {
    return { ok: false, error: "invalid_capability_arguments", message: "The version capability accepts no arguments." }
  }
  if (!input.schemaDigest) {
    return { ok: false, error: "invalid_capability_arguments", message: "Copy schemaDigest from search_capabilities before executing a CLI capability." }
  }

  let organizationId: DenTypeId<"organization">
  let connectionId: DenTypeId<"cliConnector">
  try {
    organizationId = normalizeDenTypeId("organization", input.organizationId)
    connectionId = normalizeDenTypeId("cliConnector", input.connectionId)
  } catch {
    return { ok: false, error: "unknown_capability", message: "The requested CLI capability does not exist." }
  }

  const connection = await store.getCliConnector({ organizationId, connectionId })
  if (!connection) {
    return { ok: false, error: "unknown_capability", message: "The requested CLI capability does not exist." }
  }
  if (!connection.enabled) {
    return { ok: false, error: "connector_not_ready", message: `${connection.name} is disabled.` }
  }
  const manifest = getCliConnectorManifest(connection.catalogKey, connection.manifestVersion)
  if (!manifest) {
    return { ok: false, error: "connector_not_ready", message: `${connection.name} references an unavailable manifest version.` }
  }
  if (input.schemaDigest !== manifest.digest) {
    return { ok: false, error: "unknown_capability", message: "The CLI manifest changed after discovery. Call search_capabilities again." }
  }

  const capability = buildCliCapabilityName(connection.id, "version")
  const referenceId = randomUUID()
  try {
    const execution = await runner.executeVersionProbe(manifest)
    logger.info("cli_connector_execution", {
      reference_id: referenceId,
      organization_id: organizationId,
      org_membership_id: input.member.orgMembershipId,
      connection_id: connection.id,
      capability,
      catalog_key: manifest.catalogKey,
      command_id: "version",
      risk: "read",
      manifest_version: manifest.manifestVersion,
      manifest_digest: manifest.digest,
      runner_reference: execution.runnerReference,
      exit_code: execution.exitCode,
      duration_ms: execution.durationMs,
      stdout_bytes: Buffer.byteLength(execution.stdout, "utf8"),
      stderr_bytes: Buffer.byteLength(execution.stderr, "utf8"),
      outcome: execution.exitCode === 0 ? "succeeded" : "nonzero_exit",
    })
    return {
      ok: true,
      result: {
        kind: "cli_execution",
        capability,
        connector: { id: connection.id, catalogKey: connection.catalogKey, name: connection.name },
        command: "version",
        risk: "read",
        manifestVersion: manifest.manifestVersion,
        manifestDigest: manifest.digest,
        exitCode: execution.exitCode,
        stdout: execution.stdout,
        stderr: execution.stderr,
        durationMs: execution.durationMs,
        referenceId,
      },
    }
  } catch (error) {
    const unavailable = error instanceof CliRunnerUnavailableError
    logger.error("cli_connector_execution_failed", {
      reference_id: referenceId,
      organization_id: organizationId,
      org_membership_id: input.member.orgMembershipId,
      connection_id: connection.id,
      capability,
      manifest_digest: manifest.digest,
      failure_type: unavailable ? "runner_unavailable" : "execution_failed",
      error: error instanceof Error ? error.message : "unknown runner failure",
    })
    return {
      ok: false,
      error: unavailable ? "runner_unavailable" : "execution_failed",
      message: unavailable
        ? "The hosted CLI runner is not configured. Ask an OpenWork administrator to configure Daytona."
        : error instanceof CliRunnerExecutionError
          ? "The hosted GitHub CLI version check failed."
          : "The hosted CLI execution failed.",
      referenceId,
    }
  }
}

export function executeCliCapability(input: Parameters<typeof executeCliCapabilityWithRunner>[0]) {
  return executeCliCapabilityWithRunner(input, daytonaCliRunner)
}
