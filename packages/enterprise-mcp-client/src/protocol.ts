import { createHash } from "node:crypto"
import { z } from "zod"
import {
  MCP_CURRENT_PROTOCOL_VERSION,
  MCP_LEGACY_PROTOCOL_VERSION,
  type McpNormalizedResult,
  type McpProtocolBinding,
  type McpProtocolPolicy,
  type McpProtocolStatus,
  type McpSupportedProtocolVersion,
} from "./contracts.js"

const serverInfoSchema = z.object({
  name: z.string().trim().min(1).max(255),
  version: z.string().trim().min(1).max(255),
})

const serverDiscoverySchema = z.object({
  resultType: z.literal("complete"),
  supportedVersions: z.array(z.string().trim().min(1)).min(1),
  serverInfo: serverInfoSchema,
  capabilities: z.record(z.string(), z.unknown()),
  instructions: z.string().optional(),
  ttlMs: z.number().int().nonnegative(),
  cacheScope: z.enum(["private", "public"]),
})

const inputRequestSchema = z.object({
  type: z.string().trim().min(1),
  message: z.string().optional(),
  schema: z.unknown().optional(),
}).catchall(z.unknown())

const inputRequiredResultSchema = z.object({
  resultType: z.literal("input_required"),
  requestState: z.unknown(),
  inputRequests: z.record(z.string(), inputRequestSchema),
}).passthrough()

const completeResultSchema = z.object({
  resultType: z.literal("complete"),
}).catchall(z.unknown())

export type McpServerDiscovery = z.infer<typeof serverDiscoverySchema>

export type McpProtocolDiscoveryOutcome =
  | { kind: "discovered"; value: unknown }
  | {
      kind: "legacy-only"
      reason: "method-not-found" | "unsupported-version" | "legacy-lifecycle"
    }

export type McpProtocolNegotiationErrorCode =
  | "MCP_PROTOCOL_DISCOVERY_INVALID"
  | "MCP_PROTOCOL_VERSION_UNSUPPORTED"
  | "MCP_PROTOCOL_DOWNGRADE_BLOCKED"
  | "MCP_PROTOCOL_RESULT_INVALID"

export class McpProtocolNegotiationError extends Error {
  readonly code: McpProtocolNegotiationErrorCode

  constructor(code: McpProtocolNegotiationErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "McpProtocolNegotiationError"
    this.code = code
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value)
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Capability metadata must contain finite JSON numbers.")
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value !== "object") throw new Error("Capability metadata must be JSON serializable.")
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`
}

export function createMcpCapabilityHash(input: {
  capabilities: Record<string, unknown>
  extensions?: Record<string, unknown>
}): string {
  return createHash("sha256")
    .update(canonicalJson({
      capabilities: input.capabilities,
      extensions: input.extensions ?? {},
    }))
    .digest("hex")
}

export function parseMcpServerDiscovery(value: unknown): McpServerDiscovery {
  try {
    return serverDiscoverySchema.parse(value)
  } catch (error) {
    throw new McpProtocolNegotiationError(
      "MCP_PROTOCOL_DISCOVERY_INVALID",
      "The MCP server returned malformed server/discover metadata.",
      error,
    )
  }
}

function selectDiscoveredVersion(input: {
  policy: McpProtocolPolicy
  discovery: McpServerDiscovery
}): McpSupportedProtocolVersion {
  const supported = new Set(input.discovery.supportedVersions)
  if (input.policy === MCP_CURRENT_PROTOCOL_VERSION) {
    if (supported.has(MCP_CURRENT_PROTOCOL_VERSION)) return MCP_CURRENT_PROTOCOL_VERSION
  } else if (input.policy === MCP_LEGACY_PROTOCOL_VERSION) {
    if (supported.has(MCP_LEGACY_PROTOCOL_VERSION)) return MCP_LEGACY_PROTOCOL_VERSION
  } else {
    if (supported.has(MCP_CURRENT_PROTOCOL_VERSION)) return MCP_CURRENT_PROTOCOL_VERSION
    if (supported.has(MCP_LEGACY_PROTOCOL_VERSION)) return MCP_LEGACY_PROTOCOL_VERSION
  }
  throw new McpProtocolNegotiationError(
    "MCP_PROTOCOL_VERSION_UNSUPPORTED",
    `The MCP server does not support the required ${input.policy} protocol policy.`,
  )
}

function assertNoSilentDowngrade(
  previous: McpProtocolBinding | null | undefined,
  selected: McpSupportedProtocolVersion,
  policy: McpProtocolPolicy,
): void {
  if (
    policy === "auto"
    && previous?.negotiatedVersion === MCP_CURRENT_PROTOCOL_VERSION
    && selected === MCP_LEGACY_PROTOCOL_VERSION
  ) {
    throw new McpProtocolNegotiationError(
      "MCP_PROTOCOL_DOWNGRADE_BLOCKED",
      "This connection was previously bound to MCP 2026-07-28 and cannot silently downgrade.",
    )
  }
}

export function negotiateMcpProtocol(input: {
  policy: McpProtocolPolicy
  outcome: McpProtocolDiscoveryOutcome
  previousBinding?: McpProtocolBinding | null
  authorizationServerIssuer?: string | null
  establishedAt?: string
}): { binding: McpProtocolBinding; status: McpProtocolStatus } {
  if (input.outcome.kind === "legacy-only") {
    if (input.policy === MCP_CURRENT_PROTOCOL_VERSION) {
      throw new McpProtocolNegotiationError(
        "MCP_PROTOCOL_VERSION_UNSUPPORTED",
        "The MCP server explicitly reported only a legacy lifecycle while current protocol mode is required.",
      )
    }
    assertNoSilentDowngrade(input.previousBinding, MCP_LEGACY_PROTOCOL_VERSION, input.policy)
    const binding: McpProtocolBinding = {
      policy: input.policy,
      negotiatedVersion: MCP_LEGACY_PROTOCOL_VERSION,
      serverName: null,
      serverVersion: null,
      capabilityHash: createMcpCapabilityHash({ capabilities: {} }),
      authorizationServerIssuer: input.authorizationServerIssuer ?? null,
      establishedAt: input.establishedAt ?? new Date().toISOString(),
    }
    return {
      binding,
      status: {
        policy: input.policy,
        negotiatedVersion: MCP_LEGACY_PROTOCOL_VERSION,
        supportedVersions: [MCP_LEGACY_PROTOCOL_VERSION],
        currentCompatible: false,
        downgradeBlocked: input.previousBinding?.negotiatedVersion === MCP_CURRENT_PROTOCOL_VERSION,
        serverInfo: null,
        capabilities: {},
        warnings: [{
          code: input.policy === MCP_LEGACY_PROTOCOL_VERSION
            ? "MCP_FORCED_LEGACY_MODE"
            : "MCP_LEGACY_COMPATIBILITY_MODE",
          message: input.policy === MCP_LEGACY_PROTOCOL_VERSION
            ? `An administrator forced MCP ${MCP_LEGACY_PROTOCOL_VERSION} compatibility mode.`
            : `The server requires MCP ${MCP_LEGACY_PROTOCOL_VERSION} compatibility mode.`,
        }],
      },
    }
  }

  const discovery = parseMcpServerDiscovery(input.outcome.value)
  const selected = selectDiscoveredVersion({ policy: input.policy, discovery })
  assertNoSilentDowngrade(input.previousBinding, selected, input.policy)
  const capabilityHash = createMcpCapabilityHash({ capabilities: discovery.capabilities })
  const binding: McpProtocolBinding = {
    policy: input.policy,
    negotiatedVersion: selected,
    serverName: discovery.serverInfo.name,
    serverVersion: discovery.serverInfo.version,
    capabilityHash,
    authorizationServerIssuer: input.authorizationServerIssuer ?? null,
    establishedAt: input.establishedAt ?? new Date().toISOString(),
  }
  return {
    binding,
    status: {
      policy: input.policy,
      negotiatedVersion: selected,
      supportedVersions: [...discovery.supportedVersions],
      currentCompatible: discovery.supportedVersions.includes(MCP_CURRENT_PROTOCOL_VERSION),
      downgradeBlocked: input.previousBinding?.negotiatedVersion === MCP_CURRENT_PROTOCOL_VERSION,
      serverInfo: discovery.serverInfo,
      capabilities: discovery.capabilities,
      warnings: selected === MCP_LEGACY_PROTOCOL_VERSION
        ? [{
            code: "MCP_LEGACY_COMPATIBILITY_MODE",
            message: `The connection negotiated MCP ${MCP_LEGACY_PROTOCOL_VERSION}.`,
          }]
        : [],
    },
  }
}

export function normalizeMcpResult<T>(input: {
  protocolVersion: McpSupportedProtocolVersion
  value: unknown
  parseComplete: (value: unknown) => T
}): McpNormalizedResult<T> {
  if (input.protocolVersion === MCP_LEGACY_PROTOCOL_VERSION) {
    return { resultType: "complete", value: input.parseComplete(input.value) }
  }
  const inputRequired = inputRequiredResultSchema.safeParse(input.value)
  if (inputRequired.success) {
    return {
      resultType: "input_required",
      requestState: inputRequired.data.requestState,
      inputRequests: inputRequired.data.inputRequests,
    }
  }
  const complete = completeResultSchema.safeParse(input.value)
  if (complete.success) {
    const { resultType: _resultType, ...value } = complete.data
    return { resultType: "complete", value: input.parseComplete(value) }
  }
  throw new McpProtocolNegotiationError(
    "MCP_PROTOCOL_RESULT_INVALID",
    "A current-protocol MCP result omitted or malformed its required resultType.",
  )
}
