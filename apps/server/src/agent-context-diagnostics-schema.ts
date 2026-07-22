import { z } from "zod";

import type {
  AgentContextDiagnosticCheckId,
  AgentContextDiagnosticsReport,
  AgentContextDiagnosticsRequest,
} from "@openwork/types/agent-context-diagnostics";

// Keep runtime validation local: Electron imports the compiled server with Node,
// while the shared types workspace intentionally exports source for app builds.
export const AGENT_CONTEXT_DIAGNOSTICS_SCHEMA_VERSION = 1 as const;

export const AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS = [
  "request-safety",
  "workspace-runtime",
  "connect-steering-scope",
  "agent-resolution",
  "agent-prompt-markers",
  "agent-connect-tool-permissions",
  "plugin-registration",
  "mcp-inventory",
  "engine-config",
  "engine-agent",
  "engine-plugin-tools",
  "engine-mcp-sync",
  "engine-mcp-status",
  "cloud-tool-catalog",
  "organization-connections",
  "report-safety",
] as const;

const diagnosticCheckIdSchema = z.enum(AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS);
const diagnosticStatusSchema = z.enum(["passed", "warning", "failed", "skipped"]);
const diagnosticOverallSchema = z.enum(["passed", "warning", "failed"]);
const diagnosticEvidenceKindSchema = z.enum([
  "observed",
  "client-observed",
  "expected",
  "derived",
  "unavailable",
]);
const diagnosticOwnerSchema = z.enum([
  "openwork-client",
  "openwork-server",
  "opencode-engine",
  "network-admin",
  "organization-admin",
  "member",
  "member-and-organization-admin",
  "openwork-support",
]);

const forbiddenDiagnosticTextPattern = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}]/u;
const forbiddenDiagnosticTextPatternGlobal = /[\u0000-\u001f\u007f-\u009f\p{Default_Ignorable_Code_Point}]/gu;
const diagnosticUrlPattern = /\b[a-z][a-z0-9+.-]{0,31}:\s*\/\/[^\s<>"'`]+/iu;
const diagnosticAuthorizationPattern = /(?:^|[^A-Za-z0-9])(?:b[\s._-]*e[\s._-]*a[\s._-]*r[\s._-]*e[\s._-]*r|b[\s._-]*a[\s._-]*s[\s._-]*i[\s._-]*c)(?:\s|[.:=+_-])+(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}\]])/iu;
const diagnosticSecretAssignmentPattern = /(?:^|[^A-Za-z0-9])(?:a[\s._-]*u[\s._-]*t[\s._-]*h[\s._-]*o[\s._-]*r[\s._-]*i[\s._-]*z[\s._-]*a[\s._-]*t[\s._-]*i[\s._-]*o[\s._-]*n|p[\s._-]*r[\s._-]*o[\s._-]*x[\s._-]*y[\s._-]*a[\s._-]*u[\s._-]*t[\s._-]*h[\s._-]*o[\s._-]*r[\s._-]*i[\s._-]*z[\s._-]*a[\s._-]*t[\s._-]*i[\s._-]*o[\s._-]*n|a[\s._-]*c[\s._-]*c[\s._-]*e[\s._-]*s[\s._-]*s[\s._-]*t[\s._-]*o[\s._-]*k[\s._-]*e[\s._-]*n|r[\s._-]*e[\s._-]*f[\s._-]*r[\s._-]*e[\s._-]*s[\s._-]*h[\s._-]*t[\s._-]*o[\s._-]*k[\s._-]*e[\s._-]*n|i[\s._-]*d[\s._-]*t[\s._-]*o[\s._-]*k[\s._-]*e[\s._-]*n|a[\s._-]*p[\s._-]*i[\s._-]*k[\s._-]*e[\s._-]*y|x[\s._-]*a[\s._-]*p[\s._-]*i[\s._-]*k[\s._-]*e[\s._-]*y|c[\s._-]*l[\s._-]*i[\s._-]*e[\s._-]*n[\s._-]*t[\s._-]*s[\s._-]*e[\s._-]*c[\s._-]*r[\s._-]*e[\s._-]*t|p[\s._-]*a[\s._-]*s[\s._-]*s[\s._-]*w[\s._-]*o[\s._-]*r[\s._-]*d|p[\s._-]*a[\s._-]*s[\s._-]*s[\s._-]*w[\s._-]*d|s[\s._-]*e[\s._-]*c[\s._-]*r[\s._-]*e[\s._-]*t|t[\s._-]*o[\s._-]*k[\s._-]*e[\s._-]*n)[\s._-]*[:=][\s._-]*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;)}\]])/iu;
const diagnosticJwtPattern = /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/u;
const diagnosticKnownTokenPattern = /\b(?:owt_[A-Za-z0-9_-]+|ow_mcp_at_[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+)\b/iu;
const diagnosticWindowsPathPattern = /(^|[\s("'=,:])(?:[A-Za-z]:[\\/]|\\\\)[^,;)}\]>"'`\r\n]+/mu;
const diagnosticHomePathPattern = /(^|[\s("'=,:])~[\\/][^,;)}\]>"'`\r\n]+/mu;
const diagnosticPosixPathPattern = /(^|[\s("'=,:])\/(?!mcp\/agent(?:$|[\s.,;:!)}\]"']))[^/\s<>:"'`][^,;)}\]>"'`\r\n]*/mu;
const diagnosticEncodedStructuralPattern = /%(?:2f|3a|5c)/iu;
const diagnosticPercentOctetPattern = /%[0-9a-f]{2}/iu;
const MAX_DIAGNOSTIC_PERCENT_DECODE_ROUNDS = 12;
const sensitiveDiagnosticTextPatterns = [
  diagnosticUrlPattern,
  diagnosticAuthorizationPattern,
  diagnosticSecretAssignmentPattern,
  diagnosticJwtPattern,
  diagnosticKnownTokenPattern,
  diagnosticWindowsPathPattern,
  diagnosticHomePathPattern,
  diagnosticPosixPathPattern,
  diagnosticEncodedStructuralPattern,
];

function decodeDiagnosticPercentEncoding(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // One malformed UTF-8 run must not shield otherwise valid encoded ASCII
    // delimiters or keywords elsewhere in the label.
    return value.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run.replace(/%([0-9a-f]{2})/giu, (encoded, hex: string) => {
          const byte = Number.parseInt(hex, 16);
          return byte <= 0x7f ? String.fromCharCode(byte) : encoded;
        });
      }
    });
  }
}

function diagnosticTextVariants(value: string): {
  variants: string[];
  percentDecodingIncomplete: boolean;
} {
  const variants = new Set<string>();
  const add = (candidate: string) => {
    variants.add(candidate);
    variants.add(candidate.normalize("NFKC"));
  };
  add(value);

  let decodedCandidate = value.normalize("NFKC");
  for (let round = 0; round < MAX_DIAGNOSTIC_PERCENT_DECODE_ROUNDS; round += 1) {
    const decoded = decodeDiagnosticPercentEncoding(decodedCandidate).normalize("NFKC");
    if (decoded === decodedCandidate) break;
    decodedCandidate = decoded;
    add(decodedCandidate);
  }
  // A label that still contains an encoded octet, or can be decoded again,
  // is malformed or exceeded the bounded normalization we can safely reason
  // about. Treat it as sensitive instead of allowing nesting to hide a secret.
  const percentDecodingIncomplete = diagnosticPercentOctetPattern.test(decodedCandidate)
    || decodeDiagnosticPercentEncoding(decodedCandidate).normalize("NFKC") !== decodedCandidate;

  for (let round = 0; round < 4; round += 1) {
    for (const candidate of [...variants]) {
      if (candidate.includes("+")) add(candidate.replaceAll("+", " "));
      const punctuationSpaced = candidate.replace(/[\p{P}\p{S}]/gu, (character) =>
        character === ":" || character === "=" ? character : " ",
      );
      if (punctuationSpaced !== candidate) add(punctuationSpaced);
      if (/%[0-9a-f]{2}/iu.test(candidate)) {
        add(candidate.replace(/%[0-9a-f]{2}/giu, ""));
        add(candidate.replace(/%[0-9a-f]{2}/giu, " "));
      }
      if (!forbiddenDiagnosticTextPattern.test(candidate)) continue;
      add(candidate.replace(forbiddenDiagnosticTextPatternGlobal, ""));
      add(candidate.replace(forbiddenDiagnosticTextPatternGlobal, " "));
    }
  }
  return { variants: [...variants], percentDecodingIncomplete };
}

function containsSensitiveDiagnosticText(value: string): boolean {
  const normalized = value.normalize("NFKC");
  if (normalized !== value && /[\\/]/u.test(normalized)) return true;
  const { variants, percentDecodingIncomplete } = diagnosticTextVariants(value);
  if (percentDecodingIncomplete) return true;
  return variants.some((variant) =>
    sensitiveDiagnosticTextPatterns.some((pattern) => pattern.test(variant)),
  );
}

export function sanitizeAgentContextDiagnosticText(value: string): string {
  if (value.length > 500) return "[redacted-sensitive-label]";
  if (containsSensitiveDiagnosticText(value)) return "[redacted-sensitive-label]";
  return value.normalize("NFKC").replace(forbiddenDiagnosticTextPatternGlobal, "");
}

export function isAgentContextDiagnosticTextSafe(value: string): boolean {
  if (value.length > 500) return false;
  if (forbiddenDiagnosticTextPattern.test(value)) return false;
  return !containsSensitiveDiagnosticText(value);
}

const safeTextSchema = z.string()
  .max(500)
  .refine(
    isAgentContextDiagnosticTextSafe,
    "diagnostic text cannot contain controls, credentials, URLs, or absolute paths",
  );
const registrationFailureDetailSchema = z.object({
  name: safeTextSchema.min(1).max(160),
  status: z.enum(["connected", "disabled", "failed", "needs-auth", "needs-client-registration", "not-recorded"]),
  source: z.enum(["transport_failure", "engine_status"]).nullable(),
  recordAgeMs: z.number().int().nonnegative().nullable(),
  engineReachableNow: z.boolean(),
}).strict();
const organizationConnectionNameSchema = z.string()
  .min(1)
  .max(160)
  .refine((value) => value.trim().length > 0, "connection names cannot be blank")
  .refine(
    isAgentContextDiagnosticTextSafe,
    "connection names cannot contain controls, credentials, URLs, or absolute paths",
  );
const safeDetailValueSchema = z.union([
  safeTextSchema,
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(safeTextSchema).max(100),
  z.array(registrationFailureDetailSchema).max(100),
]);
const toolIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/);

function uniqueToolIdsSchema(max: number) {
  return z.array(toolIdSchema).max(max).superRefine((toolIds, context) => {
    const seen = new Set<string>();
    toolIds.forEach((toolId, index) => {
      if (seen.has(toolId)) {
        context.addIssue({
          code: "custom",
          message: "tool IDs must be unique",
          path: [index],
        });
      }
      seen.add(toolId);
    });
  });
}

export const agentContextDiagnosticCheckRuntimeSchema = z.object({
  id: diagnosticCheckIdSchema,
  status: diagnosticStatusSchema,
  evidenceKind: diagnosticEvidenceKindSchema,
  code: safeTextSchema.min(1).max(120),
  message: safeTextSchema.min(1).max(500),
  owner: diagnosticOwnerSchema,
  action: safeTextSchema.min(1).max(500),
  details: z.record(safeTextSchema.min(1).max(80), safeDetailValueSchema)
    .refine((value) => Object.keys(value).length <= 30, "details may contain at most 30 keys"),
  durationMs: z.number().int().nonnegative(),
}).strict();

const organizationConnectionSummarySchema = z.object({
  id: z.string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9_.:-]+$/)
    .refine(
      isAgentContextDiagnosticTextSafe,
      "connection IDs cannot contain credentials or token-shaped values",
    ),
  name: organizationConnectionNameSchema,
  credentialMode: z.enum(["shared", "per_member"]),
  connected: z.boolean(),
  connectedForMe: z.boolean(),
  needsReconnect: z.boolean(),
  missingFeatureCount: z.number().int().nonnegative().max(100),
}).strict();

const organizationConnectionsProbeSchema = z.object({
  status: z.enum(["observed", "unavailable", "skipped"]),
  code: z.enum(["signed_out", "list_failed", "not_attempted", "remote_workspace_privacy"]).nullable(),
  totalCount: z.number().int().nonnegative().max(1_000_000),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.status === "observed" && value.code !== null) {
    context.addIssue({ code: "custom", message: "observed probes cannot have an error code", path: ["code"] });
  }
  if (value.status === "unavailable" && value.code !== "list_failed") {
    context.addIssue({ code: "custom", message: "unavailable probes require list_failed", path: ["code"] });
  }
  if (
    value.status === "skipped"
    && value.code !== "signed_out"
    && value.code !== "not_attempted"
    && value.code !== "remote_workspace_privacy"
  ) {
    context.addIssue({ code: "custom", message: "skipped probes require a skipped code", path: ["code"] });
  }
  if (value.status !== "observed" && (value.totalCount !== 0 || value.truncated)) {
    context.addIssue({
      code: "custom",
      message: "unobserved probes cannot report connection counts",
      path: ["totalCount"],
    });
  }
});

export const agentContextDiagnosticsRequestSchema = z.object({
  organizationConnectionsProbe: organizationConnectionsProbeSchema,
  organizationConnections: z.array(organizationConnectionSummarySchema).max(200),
}).strict().superRefine((value, context) => {
  if (value.organizationConnectionsProbe.status !== "observed" && value.organizationConnections.length > 0) {
    context.addIssue({
      code: "custom",
      message: "organization connection rows require an observed organization probe",
      path: ["organizationConnections"],
    });
  }
  if (value.organizationConnectionsProbe.status === "observed") {
    const { totalCount, truncated } = value.organizationConnectionsProbe;
    if (totalCount < value.organizationConnections.length) {
      context.addIssue({
        code: "custom",
        message: "observed totalCount cannot be smaller than the reported rows",
        path: ["organizationConnectionsProbe", "totalCount"],
      });
    }
    if (truncated !== (totalCount > value.organizationConnections.length)) {
      context.addIssue({
        code: "custom",
        message: "truncated must describe whether observed rows were omitted",
        path: ["organizationConnectionsProbe", "truncated"],
      });
    }
  }

  const seenIds = new Set<string>();
  value.organizationConnections.forEach((connection, index) => {
    if (seenIds.has(connection.id)) {
      context.addIssue({
        code: "custom",
        message: "organization connection IDs must be unique",
        path: ["organizationConnections", index, "id"],
      });
    }
    seenIds.add(connection.id);
  });
});

const toolPermissionSchema = z.enum(["allowed", "approval-required", "denied", "unspecified"]);
const promptEvidenceSchema = z.object({
  length: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  markers: z.object({
    searchCapabilities: z.boolean(),
    executeCapability: z.boolean(),
    memoryBank: z.boolean(),
  }).strict(),
}).strict();

const agentEvidenceSchema = z.object({
  evidenceSource: z.enum(["effective-engine", "configured-intent"]),
  defaultAgent: safeTextSchema.max(160).nullable(),
  configuredOpenworkAgent: z.object({
    state: z.enum(["present", "missing", "configured-disabled"]),
    mode: z.enum(["subagent", "primary", "all"]).nullable(),
    prompt: promptEvidenceSchema,
    connectToolPermissions: z.object({
      searchCapabilities: toolPermissionSchema,
      executeCapability: toolPermissionSchema,
      deniedRelevantToolCount: z.number().int().nonnegative().nullable(),
    }).strict(),
  }).strict(),
  pluginLabels: z.array(safeTextSchema.min(1).max(160)).max(100),
}).strict();

const mcpEvidenceSchema = z.object({
  name: safeTextSchema.min(1).max(160),
  source: z.enum(["engine.config", "config.project", "config.global", "config.remote"]),
  type: z.enum(["local", "remote", "unknown"]),
  enabled: z.boolean(),
  disabledByTools: z.boolean(),
  origin: safeTextSchema.max(240).nullable(),
  path: z.literal("/mcp/agent").nullable(),
  hasHeaders: z.boolean(),
  oauthMode: z.enum(["auto", "configured", "disabled", "none", "unknown"]),
  syncStatus: z.enum([
    "connected",
    "disabled",
    "failed",
    "needs-auth",
    "needs-client-registration",
    "not-recorded",
    "not-applicable",
  ]),
  liveEngineStatus: z.literal("unavailable"),
}).strict();

const connectEvidenceSchema = z.object({
  connectEnabled: z.boolean(),
  legacyGoogleWorkspaceConfigured: z.boolean(),
  expectedBranch: z.enum(["cloud-active", "cloud-disconnected", "extensions-only"]),
  globalCloudMcpPresent: z.boolean(),
  selectedWorkspaceCloudMcpPresent: z.boolean(),
  crossWorkspaceSteeringDrift: z.boolean(),
}).strict();

export const agentContextDiagnosticsReportSchema = z.object({
  schemaVersion: z.literal(AGENT_CONTEXT_DIAGNOSTICS_SCHEMA_VERSION),
  runId: z.string().uuid(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  overall: diagnosticOverallSchema,
  firstFailedCheck: diagnosticCheckIdSchema.nullable(),
  workspace: z.object({
    id: safeTextSchema.min(1).max(160),
    name: safeTextSchema.min(1).max(240),
    type: z.enum(["local", "remote"]),
    remoteType: z.enum(["opencode", "openwork"]).nullable(),
    engineConfigured: z.boolean(),
  }).strict(),
  checks: z.array(agentContextDiagnosticCheckRuntimeSchema).length(AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS.length),
  agent: agentEvidenceSchema,
  mcps: z.array(mcpEvidenceSchema).max(200),
  connect: connectEvidenceSchema,
  observedCloudToolIds: uniqueToolIdsSchema(100),
  organizationConnectionsProbe: organizationConnectionsProbeSchema,
  organizationConnections: z.array(organizationConnectionSummarySchema).max(200),
  safety: z.object({
    diagnosticsWorkspaceRuntimeConfigurationReadOnly: z.literal(true),
    cloudCatalogToolsListPerformed: z.boolean(),
    directNonCloudMcpFetchPerformed: z.literal(false),
    directMcpToolCallPerformed: z.literal(false),
    directProviderOperationPerformed: z.literal(false),
    directConfigurationMutationPerformed: z.literal(false),
    directEphemeralCredentialMintPerformed: z.literal(false),
    engineApiReadPerformed: z.boolean(),
    engineBootstrapMayHaveRun: z.boolean(),
    engineBootstrapSideEffectsInspected: z.literal(false),
    authSessionActivityMayBeRecorded: z.literal(true),
    tokenValuesIncluded: z.literal(false),
    authorizationHeaderValuesIncluded: z.literal(false),
    credentialValuesIncluded: z.literal(false),
    rawPromptsIncluded: z.literal(false),
    providerResponsesIncluded: z.literal(false),
    stackTracesIncluded: z.literal(false),
    rawEngineErrorsIncluded: z.literal(false),
    secretBearingUrlsIncluded: z.literal(false),
    inputStrictlyValidated: z.literal(true),
  }).strict(),
}).strict().superRefine((value, context) => {
  const ids = value.checks.map((check) => check.id);
  const unique = new Set(ids);
  const expected = new Set(AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS);
  if (unique.size !== expected.size || ids.some((id) => !expected.has(id))) {
    context.addIssue({
      code: "custom",
      message: "checks must contain each diagnostic check exactly once",
      path: ["checks"],
    });
  }
  ids.forEach((id, index) => {
    if (id !== AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS[index]) {
      context.addIssue({
        code: "custom",
        message: "checks must use canonical diagnostic order",
        path: ["checks", index, "id"],
      });
    }
  });

  const expectedOverall = value.checks.some((check) => check.status === "failed")
    ? "failed"
    : value.checks.some((check) => check.status === "warning")
      ? "warning"
      : "passed";
  if (value.overall !== expectedOverall) {
    context.addIssue({
      code: "custom",
      message: "overall must match the highest-severity check",
      path: ["overall"],
    });
  }

  const expectedFirstFailedCheck = value.checks.find((check) => check.status === "failed")?.id ?? null;
  if (value.firstFailedCheck !== expectedFirstFailedCheck) {
    context.addIssue({
      code: "custom",
      message: "firstFailedCheck must identify the first failed check",
      path: ["firstFailedCheck"],
    });
  }

  if (value.organizationConnectionsProbe.status !== "observed" && value.organizationConnections.length > 0) {
    context.addIssue({
      code: "custom",
      message: "organization connection rows require an observed organization probe",
      path: ["organizationConnections"],
    });
  }
  if (value.organizationConnectionsProbe.status === "observed") {
    const { totalCount, truncated } = value.organizationConnectionsProbe;
    if (totalCount < value.organizationConnections.length) {
      context.addIssue({
        code: "custom",
        message: "observed totalCount cannot be smaller than the reported rows",
        path: ["organizationConnectionsProbe", "totalCount"],
      });
    }
    if (truncated !== (totalCount > value.organizationConnections.length)) {
      context.addIssue({
        code: "custom",
        message: "truncated must describe whether observed rows were omitted",
        path: ["organizationConnectionsProbe", "truncated"],
      });
    }
  }

  if (!value.safety.cloudCatalogToolsListPerformed && value.observedCloudToolIds.length > 0) {
    context.addIssue({
      code: "custom",
      message: "observed cloud tools require a completed cloud tools/list request",
      path: ["observedCloudToolIds"],
    });
  }

  if (!value.safety.engineApiReadPerformed) {
    value.checks.forEach((check, index) => {
      if (check.id !== "engine-config" && check.id !== "engine-agent") return;
      if (check.status !== "warning" || check.evidenceKind !== "unavailable") {
        context.addIssue({
          code: "custom",
          message: "engine config and agent checks require unavailable warnings when no engine API read ran",
          path: ["checks", index],
        });
      }
    });
  }

  const engineConfigCheck = value.checks.find((check) => check.id === "engine-config");
  const engineAgentCheck = value.checks.find((check) => check.id === "engine-agent");
  const toolPolicyCheck = value.checks.find((check) => check.id === "agent-connect-tool-permissions");
  if (value.agent.evidenceSource === "effective-engine") {
    if (!value.safety.engineApiReadPerformed) {
      context.addIssue({
        code: "custom",
        message: "effective engine evidence requires an engine API read",
        path: ["agent", "evidenceSource"],
      });
    }
    if (engineConfigCheck?.status !== "passed" || engineConfigCheck.evidenceKind !== "observed") {
      context.addIssue({
        code: "custom",
        message: "effective engine evidence requires an observed engine configuration",
        path: ["checks"],
      });
    }
    if (engineAgentCheck?.evidenceKind !== "observed") {
      context.addIssue({
        code: "custom",
        message: "effective engine evidence requires an observed agent response",
        path: ["checks"],
      });
    }
  } else if (value.mcps.some((mcp) => mcp.source === "engine.config")) {
    context.addIssue({
      code: "custom",
      message: "engine configuration MCP sources require effective engine evidence",
      path: ["mcps"],
    });
  }

  if (value.safety.engineBootstrapMayHaveRun !== value.safety.engineApiReadPerformed) {
    context.addIssue({
      code: "custom",
      message: "engine bootstrap possibility must track whether an engine API read was attempted",
      path: ["safety", "engineBootstrapMayHaveRun"],
    });
  }

  if (value.safety.cloudCatalogToolsListPerformed) {
    const runtimeCloudMcp = value.mcps.find((mcp) =>
      mcp.source === "config.remote"
      && mcp.name === "openwork-cloud"
      && mcp.path === "/mcp/agent"
      && mcp.syncStatus === "connected",
    );
    if (!runtimeCloudMcp) {
      context.addIssue({
        code: "custom",
        message: "cloud tools/list requires retained connected runtime OpenWork Cloud evidence",
        path: ["mcps"],
      });
    }
    if (value.agent.evidenceSource !== "effective-engine" || toolPolicyCheck?.status !== "passed") {
      context.addIssue({
        code: "custom",
        message: "cloud tools/list requires observed effective agent policy that does not deny the candidate tool IDs",
        path: ["safety", "cloudCatalogToolsListPerformed"],
      });
    }
  }
});

type IsExact<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? true
    : false
  : false;
type AssertExact<Exact extends true> = Exact;
type LocalDiagnosticCheckId = (typeof AGENT_CONTEXT_DIAGNOSTIC_CHECK_IDS)[number];
type LocalCheckIdsMatchSharedContract = AssertExact<
  IsExact<LocalDiagnosticCheckId, AgentContextDiagnosticCheckId>
>;
type LocalRequestMatchesSharedContract = AssertExact<
  IsExact<z.infer<typeof agentContextDiagnosticsRequestSchema>, AgentContextDiagnosticsRequest>
>;
type LocalReportMatchesSharedContract = AssertExact<
  IsExact<z.infer<typeof agentContextDiagnosticsReportSchema>, AgentContextDiagnosticsReport>
>;
