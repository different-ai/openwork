import { realpath } from "node:fs/promises";
import path from "node:path";
import type { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  ScheduledTaskArtifactReference,
  ScheduledTaskExecutionEvent,
  ScheduledTaskExecutionRequest,
  ScheduledTaskExecutionResult,
  ScheduledTaskGrant,
  ScheduledTaskNeedsAttention,
  ScheduledTaskTypedError,
} from "@openwork/types/scheduled-tasks";
import type { WorkspaceInfo } from "../types.js";
import type {
  ScheduledTaskCancellationRequest,
  ScheduledTaskCancellationResult,
  ScheduledTaskExecutionAdapter,
  ScheduledTaskExecutionOptions,
} from "./execution.js";
import {
  SCHEDULED_TASK_SAFE_WRITE_TOOL_ID,
  SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID,
  SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID,
  validateScheduledTaskCapabilityGrant,
} from "./execution.js";

type OpencodeClient = ReturnType<typeof createOpencodeClient>;

type SdkResult = {
  data?: unknown;
  error?: unknown;
  response?: Response;
};

type PermissionRule = {
  permission: string;
  pattern: string;
  action: "allow" | "deny" | "ask";
};

type NormalizedEvent = {
  directory: string | null;
  id: string | null;
  type: string;
  properties: Record<string, unknown>;
};

type ActiveExecution = {
  runId: string;
  attemptId: string;
  client: OpencodeClient;
  sessionId: string;
  cancellation: ScheduledTaskCancellationResult | null;
};

type ReconciliationSnapshot = {
  state: "busy" | "retry" | "idle" | "unknown";
  assistantCompleted: boolean;
  assistantError: ScheduledTaskTypedError | null;
  attention: "approval" | "question" | null;
  artifactCandidates: string[];
  boundedUsage: {
    inputTokens: number | null;
    outputTokens: number | null;
    costMicros: number | null;
  };
};

export type ScheduledTaskAuthorityInspection =
  | { ok: true }
  | { ok: false; error: ScheduledTaskTypedError };

type LiveAuthorityInspection =
  | {
      ok: true;
      availablePermissionIds: ReadonlySet<string>;
    }
  | { ok: false; error: ScheduledTaskTypedError };

export interface OpencodeScheduledTaskExecutionAdapterOptions {
  authorizedRoots: readonly string[];
  resolveWorkspace: (workspaceId: string) => Promise<WorkspaceInfo>;
  createClient: (workspace: WorkspaceInfo) => OpencodeClient;
  inspectAuthority?: (input: {
    request: ScheduledTaskExecutionRequest;
    workspace: WorkspaceInfo;
    availableCapabilityIds: ReadonlySet<string>;
    connectedProviderIds: ReadonlySet<string>;
  }) => Promise<ScheduledTaskAuthorityInspection>;
  resolveArtifacts?: (input: {
    workspace: WorkspaceInfo;
    candidates: string[];
  }) => Promise<ScheduledTaskArtifactReference[]>;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs?: number;
  maximumPollIterations?: number;
}

const HARD_DENIED_PERMISSION_PATTERNS = [
  "bash",
  "shell",
  "terminal",
  "pty",
  "task",
  "code_mode",
  "openwork_execute",
  "webfetch",
  "websearch",
  "browser*",
  "computer*",
  "*send*",
  "*post*",
  "*reply*",
  "*publish*",
  "*invite*",
  "*notify*",
  "*delete*",
  "*remove*",
  "*destroy*",
  "*purge*",
  "*drop*",
  "*revoke*",
  "*scheduled*task*",
  "*automation*",
] as const;

const READ_PERMISSION_PATTERNS = ["read", "glob", "grep", "list", "ls"] as const;
const WRITE_PERMISSION_PATTERNS = [SCHEDULED_TASK_SAFE_WRITE_TOOL_ID] as const;
const NATIVE_DESTRUCTIVE_WRITE_PERMISSION_PATTERNS = [
  "write",
  "edit",
  "apply_patch",
  "patch",
  "multiedit",
] as const;
const EXECUTE_PERMISSION_PATTERNS = ["bash", "shell", "terminal", "pty", "task", "code_mode"] as const;

const OPENCODE_PERMISSION_IDS_BY_CAPABILITY = {
  [SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID]: READ_PERMISSION_PATTERNS,
  [SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID]: WRITE_PERMISSION_PATTERNS,
} as const;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MIN_POLL_INTERVAL_MS = 25;
const MAX_POLL_INTERVAL_MS = 60_000;
const MAX_ARTIFACT_CANDIDATES = 200;
const MAX_EVENT_IDS = 4_096;
const MAX_ERROR_MESSAGE_LENGTH = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function safeInteger(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function typedError(
  code: ScheduledTaskTypedError["code"],
  message: string,
  input: {
    retryable?: boolean;
    ambiguous?: boolean;
    details?: Record<string, unknown>;
  } = {},
): ScheduledTaskTypedError {
  return {
    code,
    message: message.slice(0, MAX_ERROR_MESSAGE_LENGTH),
    retryable: input.retryable ?? false,
    ambiguous: input.ambiguous ?? false,
    ...(input.details ? { details: input.details } : {}),
  };
}

function sdkStatus(result: SdkResult): number | null {
  return result.response instanceof Response ? result.response.status : null;
}

function sdkFailure(
  result: SdkResult,
  input: {
    code: ScheduledTaskTypedError["code"];
    message: string;
    retryable?: boolean;
    ambiguous?: boolean;
  },
): ScheduledTaskTypedError {
  const status = sdkStatus(result);
  return typedError(input.code, input.message, {
    retryable: input.retryable ?? (status === null || status >= 500),
    ambiguous: input.ambiguous,
    ...(status === null ? {} : { details: { upstreamStatus: status } }),
  });
}

class AdapterFailure extends Error {
  constructor(readonly normalized: ScheduledTaskTypedError) {
    super(normalized.message);
  }
}

function unwrapSdkData(
  result: SdkResult,
  input: {
    code: ScheduledTaskTypedError["code"];
    message: string;
    retryable?: boolean;
    ambiguous?: boolean;
  },
): unknown {
  if (result.data !== undefined && result.data !== null) return result.data;
  throw new AdapterFailure(sdkFailure(result, input));
}

function modelEquals(
  left: ScheduledTaskGrant["model"],
  right: ScheduledTaskGrant["model"],
): boolean {
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.agent === right.agent
  );
}

function validateReviewedAuthority(
  request: ScheduledTaskExecutionRequest,
  now: number,
): ScheduledTaskTypedError | null {
  const revision = request.taskRevision;
  const definition = revision.definition;
  const grant = request.grantRevision;

  if (
    grant.taskId !== revision.taskId ||
    grant.taskRevisionId !== revision.id ||
    grant.workspaceId !== definition.workspaceId
  ) {
    return typedError("invalid-revision", "The reviewed grant does not match the task revision.");
  }
  if (revision.reviewedAt === null || !revision.reviewedBy) {
    return typedError("invalid-revision", "The task revision has not been reviewed.");
  }
  if (grant.revokedAt !== null) {
    return typedError("grant-revoked", "The scheduled-task grant has been revoked.");
  }
  if (grant.expiresAt !== null && grant.expiresAt <= now) {
    return typedError("grant-expired", "The scheduled-task grant has expired.");
  }
  if (
    grant.maximumRuntimeMs < definition.maximumRuntimeMs ||
    !modelEquals(grant.model, definition.model)
  ) {
    return typedError(
      "invalid-grant",
      "The reviewed runtime or model does not match the task revision.",
    );
  }
  if (
    grant.communicationPolicy !== "deny" ||
    grant.destructiveActionPolicy !== "deny" ||
    grant.selfModificationPolicy !== "deny"
  ) {
    return typedError("invalid-grant", "Unattended execution requires restrictive safety policies.");
  }
  if (
    (grant.filesystem.read && !grant.actionClasses.includes("read")) ||
    (grant.filesystem.write && !grant.actionClasses.includes("write"))
  ) {
    return typedError(
      "invalid-grant",
      "The reviewed filesystem scope exceeds its allowed action classes.",
    );
  }
  if (
    grant.capabilityIds.includes(SCHEDULED_TASK_WORKSPACE_READ_CAPABILITY_ID) &&
    (!grant.filesystem.read || !grant.actionClasses.includes("read"))
  ) {
    return typedError(
      "invalid-grant",
      "A reviewed read capability exceeds the filesystem grant.",
    );
  }
  if (
    grant.capabilityIds.includes(SCHEDULED_TASK_WORKSPACE_WRITE_CAPABILITY_ID) &&
    (!grant.filesystem.write || !grant.actionClasses.includes("write"))
  ) {
    return typedError(
      "invalid-grant",
      "A reviewed write capability exceeds the filesystem grant.",
    );
  }
  if (grant.capabilityIds.some((capabilityId) => /[*?[\]{}]/u.test(capabilityId))) {
    return typedError("invalid-grant", "Capability identifiers must be exact and cannot contain wildcards.");
  }
  return null;
}

function containsPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function canonicalPath(value: string): Promise<string> {
  return path.normalize(await realpath(value));
}

async function validateAuthorizedRoots(
  configuredRoots: readonly string[],
  workspace: WorkspaceInfo,
  grant: ScheduledTaskGrant,
): Promise<string[]> {
  if (workspace.workspaceType !== "local") {
    throw new AdapterFailure(
      typedError(
        "workspace-inaccessible",
        "Scheduled tasks currently require a local workspace owned by this server.",
      ),
    );
  }

  let workspaceRoot: string;
  try {
    workspaceRoot = await canonicalPath(workspace.path);
  } catch {
    throw new AdapterFailure(
      typedError("workspace-inaccessible", "The scheduled-task workspace is not accessible."),
    );
  }

  const serverRoots = new Set<string>([workspaceRoot]);
  for (const configuredRoot of configuredRoots) {
    try {
      serverRoots.add(await canonicalPath(configuredRoot));
    } catch {
      // A stale server root grants nothing.
    }
  }

  const grantRoots: string[] = [];
  for (const requestedRoot of grant.authorizedWorkspaceRoots) {
    let canonical: string;
    try {
      canonical = await canonicalPath(requestedRoot);
    } catch {
      throw new AdapterFailure(
        typedError(
          "workspace-inaccessible",
          "One of the reviewed workspace roots is no longer accessible.",
        ),
      );
    }
    if (![...serverRoots].some((serverRoot) => containsPath(serverRoot, canonical))) {
      throw new AdapterFailure(
        typedError(
          "invalid-grant",
          "A reviewed workspace root is outside the server's authorized roots.",
        ),
      );
    }
    grantRoots.push(canonical);
  }

  if (!grantRoots.some((root) => containsPath(root, workspaceRoot))) {
    throw new AdapterFailure(
      typedError("invalid-grant", "The reviewed grant does not include the workspace root."),
    );
  }
  return [...new Set(grantRoots)];
}

function wildcardToRegExp(pattern: string): RegExp {
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, ".*")
    .replace(/\?/gu, ".");
  return new RegExp(`^${source}$`, "iu");
}

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => wildcardToRegExp(pattern).test(value));
}

function buildPermissionRules(
  request: ScheduledTaskExecutionRequest,
  authorizedRoots: string[],
  availablePermissionIds: ReadonlySet<string>,
): PermissionRule[] {
  const grant = request.grantRevision;
  const rules: PermissionRule[] = [{ permission: "*", pattern: "*", action: "deny" }];

  for (const capabilityId of grant.capabilityIds) {
    const mappedPermissionIds =
      OPENCODE_PERMISSION_IDS_BY_CAPABILITY[
        capabilityId as keyof typeof OPENCODE_PERMISSION_IDS_BY_CAPABILITY
      ];
    if (!mappedPermissionIds) continue;
    for (const permission of mappedPermissionIds) {
      if (availablePermissionIds.has(permission)) {
        rules.push({ permission, pattern: "*", action: "allow" });
      }
    }
  }

  if (grant.filesystem.read || grant.filesystem.write) {
    for (const root of authorizedRoots) {
      rules.push({ permission: "external_directory", pattern: root, action: "allow" });
      rules.push({
        permission: "external_directory",
        pattern: path.join(root, "*"),
        action: "allow",
      });
    }
  }

  // Unreviewed local filesystem actions deliberately ask rather than inherit
  // an answer. The adapter observes that pending request, aborts the session,
  // and records needs-attention without ever replying on the user's behalf.
  // Dangerous, external, and self-modifying capabilities remain hard-denied
  // by the rules appended below.
  if (!grant.filesystem.read || !grant.actionClasses.includes("read")) {
    for (const permission of READ_PERMISSION_PATTERNS) {
      rules.push({ permission, pattern: "*", action: "ask" });
    }
  }
  if (!grant.filesystem.write || !grant.actionClasses.includes("write")) {
    for (const permission of WRITE_PERMISSION_PATTERNS) {
      rules.push({ permission, pattern: "*", action: "ask" });
    }
  }
  for (const permission of NATIVE_DESTRUCTIVE_WRITE_PERMISSION_PATTERNS) {
    rules.push({ permission, pattern: "*", action: "deny" });
  }
  if (!grant.actionClasses.includes("execute")) {
    for (const permission of EXECUTE_PERMISSION_PATTERNS) {
      rules.push({ permission, pattern: "*", action: "deny" });
    }
  }

  for (const permission of HARD_DENIED_PERMISSION_PATTERNS) {
    rules.push({ permission, pattern: "*", action: "deny" });
  }
  return rules;
}

function findUnsafeCapabilities(capabilityIds: string[]): string[] {
  const validation = validateScheduledTaskCapabilityGrant(capabilityIds);
  const unsupported = validation.ok ? [] : validation.unsupportedCapabilityIds;
  return [
    ...new Set([
      ...unsupported,
      ...capabilityIds.filter((capabilityId) =>
        matchesAnyPattern(capabilityId, HARD_DENIED_PERMISSION_PATTERNS),
      ),
    ]),
  ].sort();
}

function availableScheduledTaskCapabilities(
  availablePermissionIds: ReadonlySet<string>,
): Set<string> {
  const availableCapabilityIds = new Set<string>();
  for (const [capabilityId, permissionIds] of Object.entries(
    OPENCODE_PERMISSION_IDS_BY_CAPABILITY,
  )) {
    if (permissionIds.some((permissionId) => availablePermissionIds.has(permissionId))) {
      availableCapabilityIds.add(capabilityId);
    }
  }
  return availableCapabilityIds;
}

function normalizeEvent(raw: unknown): NormalizedEvent | null {
  if (!isRecord(raw)) return null;
  const payload = isRecord(raw.payload) ? raw.payload : raw;
  if (typeof payload.type !== "string") return null;
  return {
    directory: typeof raw.directory === "string" ? path.normalize(raw.directory) : null,
    id: typeof payload.id === "string" ? payload.id : null,
    type: payload.type,
    properties: isRecord(payload.properties) ? payload.properties : {},
  };
}

function sessionIdFromEvent(event: NormalizedEvent): string | null {
  if (typeof event.properties.sessionID === "string") return event.properties.sessionID;
  const info = event.properties.info;
  return isRecord(info) && typeof info.id === "string" ? info.id : null;
}

function normalizeWireError(error: unknown): ScheduledTaskTypedError {
  const record = isRecord(error) ? error : {};
  const name = typeof record.name === "string" ? record.name : "";
  const data = isRecord(record.data) ? record.data : {};
  const statusCode = safeInteger(data.statusCode);

  if (
    name === "ProviderAuthError" ||
    statusCode === 401 ||
    statusCode === 403
  ) {
    return typedError(
      "credential-unavailable",
      "The reviewed provider credential is no longer available.",
    );
  }
  if (name === "MessageAbortedError") {
    return typedError("execution-failed", "OpenCode reported that execution was aborted.");
  }
  return typedError("execution-failed", "OpenCode reported that scheduled execution failed.", {
    retryable: Boolean(data.isRetryable),
    ...(name ? { details: { upstreamError: name } } : {}),
  });
}

function needsAttention(
  request: ScheduledTaskExecutionRequest,
  sessionId: string,
  kind: "approval" | "question",
  now: number,
): ScheduledTaskNeedsAttention {
  return {
    code: kind === "approval" ? "approval-required" : "question-required",
    message:
      kind === "approval"
        ? "The scheduled run requested an unattended permission."
        : "The scheduled run asked a question that requires user input.",
    repairable: true,
    runId: request.runId,
    sessionId,
    createdAt: now,
  };
}

function authorityNeedsAttention(
  request: ScheduledTaskExecutionRequest,
  sessionId: string,
  error: ScheduledTaskTypedError,
  now: number,
): ScheduledTaskNeedsAttention | null {
  const code = (() => {
    switch (error.code) {
      case "capability-unavailable":
        return "capability-lost" as const;
      case "credential-unavailable":
        return "credential-unavailable" as const;
      case "grant-expired":
        return "grant-expired" as const;
      case "grant-revoked":
        return "grant-revoked" as const;
      case "signed-out":
        return "signed-out" as const;
      case "workspace-inaccessible":
        return "workspace-inaccessible" as const;
      case "workspace-removed":
        return "workspace-removed" as const;
      case "invalid-revision":
        return "stale-revision" as const;
      default:
        return null;
    }
  })();
  if (!code) return null;
  return {
    code,
    message: error.message,
    repairable: true,
    runId: request.runId,
    sessionId,
    createdAt: now,
  };
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("Aborted");
      error.name = "AbortError";
      reject(error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (isRecord(error) && error.name === "AbortError")
  );
}

function arrayData(result: SdkResult): unknown[] {
  return Array.isArray(result.data) ? result.data : [];
}

function pendingForSession(items: unknown[], sessionId: string): boolean {
  return items.some(
    (item) => isRecord(item) && item.sessionID === sessionId,
  );
}

function collectArtifactCandidates(messages: unknown[]): string[] {
  const candidates = new Set<string>();
  const add = (value: unknown) => {
    if (
      typeof value === "string" &&
      value.trim() &&
      value.length <= 8_192 &&
      candidates.size < MAX_ARTIFACT_CANDIDATES
    ) {
      candidates.add(value.trim());
    }
  };

  for (const message of messages) {
    if (!isRecord(message) || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!isRecord(part)) continue;
      if (part.type === "patch" && Array.isArray(part.files)) {
        for (const file of part.files) add(file);
      }
      if (part.type === "file") {
        add(part.filename);
        const source = isRecord(part.source) ? part.source : null;
        if (source?.type === "file" || source?.type === "symbol") add(source.path);
      }
      if (part.type === "tool" && isRecord(part.state) && part.state.status === "completed") {
        const tool = typeof part.tool === "string" ? part.tool.toLowerCase() : "";
        if (
          /^(write|edit|apply_patch|patch|multiedit)$/u.test(tool)
          || tool === SCHEDULED_TASK_SAFE_WRITE_TOOL_ID
        ) {
          const input = isRecord(part.state.input) ? part.state.input : {};
          add(input.filePath);
          add(input.file_path);
          add(input.path);
        }
        if (Array.isArray(part.state.attachments)) {
          for (const attachment of part.state.attachments) {
            if (!isRecord(attachment)) continue;
            add(attachment.filename);
            if (
              typeof attachment.url === "string" &&
              attachment.url.startsWith("file:")
            ) {
              try {
                add(new URL(attachment.url).pathname);
              } catch {
                // Malformed attachment URLs are not durable artifact references.
              }
            }
          }
        }
      }
    }
  }
  return [...candidates];
}

function messageSummary(messages: unknown[]): Pick<
  ReconciliationSnapshot,
  "assistantCompleted" | "assistantError" | "artifactCandidates" | "boundedUsage"
> {
  let assistantCompleted = false;
  let assistantError: ScheduledTaskTypedError | null = null;
  let inputTokens = 0;
  let outputTokens = 0;
  let costMicros = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCost = false;

  for (const message of messages) {
    if (!isRecord(message) || !isRecord(message.info) || message.info.role !== "assistant") {
      continue;
    }
    const info = message.info;
    if (info.error !== undefined) assistantError = normalizeWireError(info.error);
    if (isRecord(info.time) && typeof info.time.completed === "number") {
      assistantCompleted = true;
    }
    if (isRecord(info.tokens)) {
      const input = safeInteger(info.tokens.input);
      const output = safeInteger(info.tokens.output);
      if (input !== null) {
        inputTokens = Math.min(Number.MAX_SAFE_INTEGER, inputTokens + input);
        sawInput = true;
      }
      if (output !== null) {
        outputTokens = Math.min(Number.MAX_SAFE_INTEGER, outputTokens + output);
        sawOutput = true;
      }
    }
    if (typeof info.cost === "number" && Number.isFinite(info.cost) && info.cost >= 0) {
      costMicros = Math.min(
        Number.MAX_SAFE_INTEGER,
        costMicros + Math.round(info.cost * 1_000_000),
      );
      sawCost = true;
    }
  }

  return {
    assistantCompleted,
    assistantError,
    artifactCandidates: collectArtifactCandidates(messages),
    boundedUsage: {
      inputTokens: sawInput ? inputTokens : null,
      outputTokens: sawOutput ? outputTokens : null,
      costMicros: sawCost ? costMicros : null,
    },
  };
}

async function inspectPendingInteractions(
  client: OpencodeClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<"approval" | "question" | null> {
  const calls = await Promise.allSettled([
    client.permission.list(undefined, { signal }),
    client.v2.session.permission.list({ sessionID: sessionId }, { signal }),
    client.question.list(undefined, { signal }),
    client.v2.session.question.list({ sessionID: sessionId }, { signal }),
  ]);

  const values = calls.map((call) =>
    call.status === "fulfilled" ? (call.value as SdkResult) : null,
  );
  if (
    pendingForSession(values[0] ? arrayData(values[0]) : [], sessionId) ||
    (values[1] ? arrayData(values[1]).length > 0 : false)
  ) {
    return "approval";
  }
  if (
    pendingForSession(values[2] ? arrayData(values[2]) : [], sessionId) ||
    (values[3] ? arrayData(values[3]).length > 0 : false)
  ) {
    return "question";
  }
  return null;
}

async function reconcileSession(
  client: OpencodeClient,
  sessionId: string,
  signal: AbortSignal,
): Promise<ReconciliationSnapshot> {
  const [statusResult, messagesResult, attention] = await Promise.all([
    client.session.status(undefined, { signal }),
    client.session.messages({ sessionID: sessionId }, { signal }),
    inspectPendingInteractions(client, sessionId, signal),
  ]);
  const statuses = unwrapSdkData(statusResult as SdkResult, {
    code: "adapter-unavailable",
    message: "OpenCode session status could not be reconciled.",
    retryable: true,
    ambiguous: true,
  });
  const messages = unwrapSdkData(messagesResult as SdkResult, {
    code: "adapter-unavailable",
    message: "OpenCode session messages could not be reconciled.",
    retryable: true,
    ambiguous: true,
  });
  const rawStatus =
    isRecord(statuses) && isRecord(statuses[sessionId])
      ? statuses[sessionId]
      : null;
  const statusType = rawStatus && typeof rawStatus.type === "string" ? rawStatus.type : "idle";
  const summary = messageSummary(Array.isArray(messages) ? messages : []);
  return {
    state:
      statusType === "busy"
        ? "busy"
        : statusType === "retry"
          ? "retry"
          : statusType === "idle"
            ? "idle"
            : "unknown",
    attention,
    ...summary,
  };
}

function cancellationError(
  message: string,
  input: { ambiguous?: boolean; retryable?: boolean } = {},
): ScheduledTaskTypedError {
  return typedError("cancellation-failed", message, {
    ambiguous: input.ambiguous,
    retryable: input.retryable,
  });
}

async function abortSession(
  client: OpencodeClient,
  sessionId: string,
): Promise<ScheduledTaskCancellationResult> {
  try {
    const result = (await client.session.abort({ sessionID: sessionId })) as SdkResult;
    if (result.data === true) return { status: "cancelled", sessionId };
    if (result.data === false) return { status: "not-running", sessionId };
    const status = sdkStatus(result);
    if (status === 404 || status === 405 || status === 501) {
      return {
        status: "unsupported",
        sessionId,
        error: cancellationError("This OpenCode engine does not support session cancellation."),
      };
    }
    return {
      status: "ambiguous",
      sessionId,
      error: cancellationError("OpenCode returned an indeterminate cancellation response.", {
        ambiguous: true,
        retryable: true,
      }),
    };
  } catch {
    return {
      status: "ambiguous",
      sessionId,
      error: cancellationError("OpenCode cancellation could not be confirmed.", {
        ambiguous: true,
        retryable: true,
      }),
    };
  }
}

function terminalErrorResult(
  status: "failed" | "cancelled" | "ambiguous",
  sessionId: string | null,
  error: ScheduledTaskTypedError,
): ScheduledTaskExecutionResult {
  return { status, sessionId, error };
}

function promptSystemPolicy(): string {
  return [
    "You are running an unattended OpenWork Scheduled Task under a reviewed grant.",
    "Use only capabilities exposed by the session permission policy.",
    `For reviewed file writes, use ${SCHEDULED_TASK_SAFE_WRITE_TOOL_ID}; native edit and patch tools are denied because they can delete or move files.`,
    "Do not communicate externally, perform destructive actions, or create, edit, enable, disable, or grant Scheduled Tasks.",
    "If a permission or user decision is required, stop and allow the run to enter needs-attention.",
  ].join(" ");
}

export function createOpencodeScheduledTaskExecutionAdapter(
  options: OpencodeScheduledTaskExecutionAdapterOptions,
): ScheduledTaskExecutionAdapter {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = clampInteger(
    options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    MIN_POLL_INTERVAL_MS,
    MAX_POLL_INTERVAL_MS,
  );
  const activeExecutions = new Map<string, ActiveExecution>();

  async function emit(
    executionOptions: ScheduledTaskExecutionOptions,
    event: ScheduledTaskExecutionEvent,
  ): Promise<void> {
    await executionOptions.onEvent?.(event);
  }

  async function inspectLiveAuthority(input: {
    client: OpencodeClient;
    request: ScheduledTaskExecutionRequest;
    workspace: WorkspaceInfo;
    signal: AbortSignal;
    ambiguousOnFailure: boolean;
  }): Promise<LiveAuthorityInspection> {
    try {
      const [toolsResult, providersResult] = await Promise.all([
        input.client.tool.ids(undefined, { signal: input.signal }),
        input.client.provider.list(undefined, { signal: input.signal }),
      ]);
      const tools = unwrapSdkData(toolsResult as SdkResult, {
        code: "adapter-unavailable",
        message: "OpenCode capabilities could not be inspected.",
        retryable: true,
        ambiguous: input.ambiguousOnFailure,
      });
      const providers = unwrapSdkData(providersResult as SdkResult, {
        code: "adapter-unavailable",
        message: "OpenCode providers could not be inspected.",
        retryable: true,
        ambiguous: input.ambiguousOnFailure,
      });
      const availablePermissionIds = new Set(
        Array.isArray(tools)
          ? tools.filter((tool): tool is string => typeof tool === "string")
          : [],
      );
      const availableCapabilityIds =
        availableScheduledTaskCapabilities(availablePermissionIds);
      const connectedProviderIds = new Set(
        isRecord(providers) && Array.isArray(providers.connected)
          ? providers.connected.filter(
              (provider): provider is string => typeof provider === "string",
            )
          : [],
      );

      const missingCapabilities = input.request.grantRevision.capabilityIds.filter(
        (capabilityId) => !availableCapabilityIds.has(capabilityId),
      );
      if (missingCapabilities.length > 0) {
        return {
          ok: false,
          error: typedError(
            "capability-unavailable",
            "One or more reviewed capabilities are no longer available.",
            { details: { capabilityIds: missingCapabilities.slice(0, 20) } },
          ),
        };
      }
      const providerId = input.request.grantRevision.model.providerId;
      if (providerId && !connectedProviderIds.has(providerId)) {
        return {
          ok: false,
          error: typedError(
            "credential-unavailable",
            "The reviewed model provider is no longer connected.",
          ),
        };
      }
      if (options.inspectAuthority) {
        const inspection = await options.inspectAuthority({
          request: input.request,
          workspace: input.workspace,
          availableCapabilityIds,
          connectedProviderIds,
        });
        if (!inspection.ok) return inspection;
      }
      return { ok: true, availablePermissionIds };
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof AdapterFailure) {
        return {
          ok: false,
          error: {
            ...error.normalized,
            ambiguous: error.normalized.ambiguous || input.ambiguousOnFailure,
          },
        };
      }
      return {
        ok: false,
        error: typedError(
          "adapter-unavailable",
          "Scheduled-task authority could not be inspected.",
          {
            retryable: true,
            ambiguous: input.ambiguousOnFailure,
          },
        ),
      };
    }
  }

  async function execute(
    request: ScheduledTaskExecutionRequest,
    executionOptions: ScheduledTaskExecutionOptions,
  ): Promise<ScheduledTaskExecutionResult> {
    let sessionId: string | null = null;
    let client: OpencodeClient | null = null;
    let active: ActiveExecution | null = null;
    let runtimeTimedOut = false;
    let promptDispatched = false;
    const executionController = new AbortController();
    const abortFromCaller = () => executionController.abort();
    executionOptions.signal.addEventListener("abort", abortFromCaller, { once: true });

    const maximumRuntimeMs = Math.min(
      request.taskRevision.definition.maximumRuntimeMs,
      request.grantRevision.maximumRuntimeMs,
    );
    const runtimeTimer = setTimeout(() => {
      runtimeTimedOut = true;
      executionController.abort();
    }, maximumRuntimeMs);

    const finish = async (
      result: ScheduledTaskExecutionResult,
    ): Promise<ScheduledTaskExecutionResult> => {
      if (sessionId && result.status !== "needs-attention") {
        await emit(executionOptions, {
          type: "terminal",
          at: now(),
          sessionId,
          status: result.status,
        });
      }
      return result;
    };

    try {
      const reviewedAuthorityError = validateReviewedAuthority(request, now());
      if (reviewedAuthorityError) {
        return terminalErrorResult("failed", null, reviewedAuthorityError);
      }
      if (executionOptions.signal.aborted) {
        return terminalErrorResult(
          "cancelled",
          null,
          typedError("execution-failed", "Scheduled execution was cancelled before dispatch."),
        );
      }

      let workspace: WorkspaceInfo;
      try {
        workspace = await options.resolveWorkspace(
          request.taskRevision.definition.workspaceId,
        );
      } catch {
        return terminalErrorResult(
          "failed",
          null,
          typedError("workspace-removed", "The scheduled-task workspace is no longer available."),
        );
      }
      const authorizedRoots = await validateAuthorizedRoots(
        options.authorizedRoots,
        workspace,
        request.grantRevision,
      );
      const unsafeCapabilities = findUnsafeCapabilities(request.grantRevision.capabilityIds);
      if (unsafeCapabilities.length > 0) {
        return terminalErrorResult(
          "failed",
          null,
          typedError(
            "invalid-grant",
            "The reviewed grant includes capabilities that are not permitted for unattended execution.",
            { details: { capabilityIds: unsafeCapabilities.slice(0, 20) } },
          ),
        );
      }

      client = options.createClient(workspace);
      const initialAuthority = await inspectLiveAuthority({
        client,
        request,
        workspace,
        signal: executionController.signal,
        ambiguousOnFailure: false,
      });
      if (!initialAuthority.ok) {
        return terminalErrorResult("failed", null, initialAuthority.error);
      }

      const observed = {
        running: false,
        idle: false,
        attention: null as "approval" | "question" | null,
        error: null as ScheduledTaskTypedError | null,
        artifactCandidates: new Set<string>(),
      };
      const seenEventIds = new Set<string>();
      let observedSessionId: string | null = null;
      const normalizedWorkspacePath = path.normalize(workspace.path);

      const observation = client.event
        .subscribe(undefined, { signal: executionController.signal })
        .then(async (subscription) => {
          for await (const raw of subscription.stream) {
            if (executionController.signal.aborted) break;
            const event = normalizeEvent(raw);
            if (!event) continue;
            if (
              event.directory &&
              event.directory !== normalizedWorkspacePath &&
              !containsPath(normalizedWorkspacePath, event.directory)
            ) {
              continue;
            }
            if (event.id) {
              if (seenEventIds.has(event.id)) continue;
              if (seenEventIds.size >= MAX_EVENT_IDS) seenEventIds.clear();
              seenEventIds.add(event.id);
            }
            const eventSessionId = sessionIdFromEvent(event);
            if (!observedSessionId || eventSessionId !== observedSessionId) continue;

            if (event.type === "session.status") {
              const status = event.properties.status;
              const statusType = isRecord(status) ? status.type : null;
              if (statusType === "busy" || statusType === "retry") observed.running = true;
              if (statusType === "idle") observed.idle = true;
            } else if (event.type === "session.idle") {
              observed.idle = true;
            } else if (event.type === "session.error") {
              observed.error = normalizeWireError(event.properties.error);
            } else if (
              event.type === "permission.asked" ||
              event.type === "permission.v2.asked"
            ) {
              observed.attention = "approval";
            } else if (
              event.type === "question.asked" ||
              event.type === "question.v2.asked"
            ) {
              observed.attention = "question";
            } else if (event.type === "session.next.tool.success") {
              const outputPaths = event.properties.outputPaths;
              if (Array.isArray(outputPaths)) {
                for (const candidate of outputPaths) {
                  if (
                    typeof candidate === "string" &&
                    observed.artifactCandidates.size < MAX_ARTIFACT_CANDIDATES
                  ) {
                    observed.artifactCandidates.add(candidate);
                  }
                }
              }
            }
          }
        })
        .catch(() => {
          // Polling and final reconciliation are authoritative after a stream gap.
        });
      void observation;

      const model = request.grantRevision.model;
      const createResult = await client.session.create(
        {
          title: `Scheduled: ${request.taskRevision.definition.name}`.slice(0, 120),
          ...(model.agent ? { agent: model.agent } : {}),
          ...(model.providerId && model.modelId
            ? { model: { providerID: model.providerId, id: model.modelId } }
            : {}),
          metadata: {
            openworkScheduledTask: true,
            scheduledTaskRunId: request.runId,
            scheduledTaskAttemptId: request.attemptId,
            scheduledTaskRevisionId: request.taskRevision.id,
            scheduledTaskGrantId: request.grantRevision.id,
            idempotencyKey: request.idempotencyKey,
          },
          permission: buildPermissionRules(
            request,
            authorizedRoots,
            initialAuthority.availablePermissionIds,
          ),
        },
        { signal: executionController.signal },
      );
      const session = unwrapSdkData(createResult as SdkResult, {
        code: "session-create-failed",
        message: "OpenCode could not create a fresh scheduled-task session.",
        retryable: true,
      });
      if (!isRecord(session) || typeof session.id !== "string" || !session.id.trim()) {
        throw new AdapterFailure(
          typedError(
            "session-create-failed",
            "OpenCode returned an invalid scheduled-task session.",
          ),
        );
      }
      const activeSessionId = session.id;
      sessionId = activeSessionId;
      observedSessionId = sessionId;
      active = {
        runId: request.runId,
        attemptId: request.attemptId,
        client,
        sessionId,
        cancellation: null,
      };
      activeExecutions.set(sessionId, active);
      const readCancellation = () =>
        activeExecutions.get(activeSessionId)?.cancellation ?? null;

      await emit(executionOptions, {
        type: "session-created",
        at: now(),
        sessionId,
      });

      const preDispatchAuthority = await inspectLiveAuthority({
        client,
        request,
        workspace,
        signal: executionController.signal,
        ambiguousOnFailure: false,
      });
      if (!preDispatchAuthority.ok) {
        const attention = authorityNeedsAttention(
          request,
          sessionId,
          preDispatchAuthority.error,
          now(),
        );
        if (attention) {
          await emit(executionOptions, {
            type: "needs-attention",
            at: now(),
            sessionId,
            attention,
          });
          await abortSession(client, sessionId);
          return { status: "needs-attention", sessionId, attention };
        }
        throw new AdapterFailure(preDispatchAuthority.error);
      }

      // Do not pass a non-empty `tools` map here. OpenCode treats that map as
      // a replacement session ruleset, which would discard the reviewed root
      // and hard-deny rules installed by session.create.
      const promptResult = await client.session.promptAsync(
        {
          sessionID: sessionId,
          ...(model.agent ? { agent: model.agent } : {}),
          ...(model.providerId && model.modelId
            ? { model: { providerID: model.providerId, modelID: model.modelId } }
            : {}),
          system: promptSystemPolicy(),
          parts: [{ type: "text", text: request.taskRevision.definition.prompt }],
        },
        { signal: executionController.signal },
      );
      if ((promptResult as SdkResult).error !== undefined) {
        throw new AdapterFailure(
          sdkFailure(promptResult as SdkResult, {
            code: "dispatch-failed",
            message: "OpenCode rejected the scheduled-task prompt.",
            retryable: true,
          }),
        );
      }
      promptDispatched = true;
      await emit(executionOptions, {
        type: "dispatched",
        at: now(),
        sessionId,
      });

      const maximumPollIterations = clampInteger(
        options.maximumPollIterations ??
          Math.max(2, Math.ceil(maximumRuntimeMs / pollIntervalMs) + 2),
        1,
        1_000_000,
      );
      let emittedRunning = false;
      let lastSnapshot: ReconciliationSnapshot | null = null;

      for (let iteration = 0; iteration < maximumPollIterations; iteration += 1) {
        const cancellation = readCancellation();
        if (cancellation) {
          if (cancellation.status === "cancelled") {
            return finish(
              terminalErrorResult(
                "cancelled",
                sessionId,
                typedError("execution-failed", "Scheduled execution was cancelled."),
              ),
            );
          }
          if (
            cancellation.status === "unsupported" ||
            cancellation.status === "ambiguous"
          ) {
            return finish(
              terminalErrorResult("ambiguous", sessionId, cancellation.error),
            );
          }
        }
        if (executionController.signal.aborted) break;

        const liveAuthority = await inspectLiveAuthority({
          client,
          request,
          workspace,
          signal: executionController.signal,
          ambiguousOnFailure: true,
        });
        if (!liveAuthority.ok) {
          const attention = authorityNeedsAttention(
            request,
            sessionId,
            liveAuthority.error,
            now(),
          );
          if (attention) {
            await emit(executionOptions, {
              type: "needs-attention",
              at: now(),
              sessionId,
              attention,
            });
            await abortSession(client, sessionId);
            return { status: "needs-attention", sessionId, attention };
          }
          return finish(
            terminalErrorResult(
              liveAuthority.error.ambiguous ? "ambiguous" : "failed",
              sessionId,
              liveAuthority.error,
            ),
          );
        }

        if (observed.error) {
          return finish(terminalErrorResult("failed", sessionId, observed.error));
        }
        if (observed.attention) {
          const attention = needsAttention(request, sessionId, observed.attention, now());
          await emit(executionOptions, {
            type: "needs-attention",
            at: now(),
            sessionId,
            attention,
          });
          await abortSession(client, sessionId);
          return { status: "needs-attention", sessionId, attention };
        }

        try {
          lastSnapshot = await reconcileSession(
            client,
            sessionId,
            executionController.signal,
          );
        } catch (error) {
          if (isAbortError(error)) break;
          if (error instanceof AdapterFailure && iteration + 1 >= maximumPollIterations) {
            return finish(
              terminalErrorResult("ambiguous", sessionId, {
                ...error.normalized,
                code: "ambiguous-outcome",
                ambiguous: true,
              }),
            );
          }
          await sleep(pollIntervalMs, executionController.signal);
          continue;
        }

        if (lastSnapshot.attention) {
          const attention = needsAttention(
            request,
            sessionId,
            lastSnapshot.attention,
            now(),
          );
          await emit(executionOptions, {
            type: "needs-attention",
            at: now(),
            sessionId,
            attention,
          });
          await abortSession(client, sessionId);
          return { status: "needs-attention", sessionId, attention };
        }
        if (lastSnapshot.assistantError) {
          return finish(
            terminalErrorResult("failed", sessionId, lastSnapshot.assistantError),
          );
        }
        if (
          !emittedRunning &&
          (observed.running ||
            lastSnapshot.state === "busy" ||
            lastSnapshot.state === "retry")
        ) {
          emittedRunning = true;
          await emit(executionOptions, {
            type: "running",
            at: now(),
            sessionId,
          });
        }
        if (
          (observed.idle || lastSnapshot.state === "idle") &&
          lastSnapshot.assistantCompleted
        ) {
          const finalAuthority = await inspectLiveAuthority({
            client,
            request,
            workspace,
            signal: executionController.signal,
            ambiguousOnFailure: true,
          });
          if (!finalAuthority.ok) {
            const attention = authorityNeedsAttention(
              request,
              sessionId,
              finalAuthority.error,
              now(),
            );
            if (attention) {
              await emit(executionOptions, {
                type: "needs-attention",
                at: now(),
                sessionId,
                attention,
              });
              await abortSession(client, sessionId);
              return { status: "needs-attention", sessionId, attention };
            }
            return finish(
              terminalErrorResult(
                finalAuthority.error.ambiguous ? "ambiguous" : "failed",
                sessionId,
                finalAuthority.error,
              ),
            );
          }
          const candidates = [
            ...new Set([
              ...observed.artifactCandidates,
              ...lastSnapshot.artifactCandidates,
            ]),
          ].slice(0, MAX_ARTIFACT_CANDIDATES);
          let artifacts: ScheduledTaskArtifactReference[] = [];
          if (options.resolveArtifacts && candidates.length > 0) {
            try {
              artifacts = (
                await options.resolveArtifacts({ workspace, candidates })
              ).slice(0, MAX_ARTIFACT_CANDIDATES);
            } catch {
              // Execution is complete even if optional artifact indexing fails.
            }
          }
          const artifactCancellation = readCancellation();
          if (artifactCancellation?.status === "cancelled") {
            return finish(
              terminalErrorResult(
                "cancelled",
                sessionId,
                typedError("execution-failed", "Scheduled execution was cancelled."),
              ),
            );
          }
          if (
            artifactCancellation?.status === "unsupported"
            || artifactCancellation?.status === "ambiguous"
          ) {
            return finish(
              terminalErrorResult(
                "ambiguous",
                sessionId,
                artifactCancellation.error,
              ),
            );
          }
          const completionAuthority = await inspectLiveAuthority({
            client,
            request,
            workspace,
            signal: executionController.signal,
            ambiguousOnFailure: true,
          });
          if (!completionAuthority.ok) {
            const attention = authorityNeedsAttention(
              request,
              sessionId,
              completionAuthority.error,
              now(),
            );
            if (attention) {
              await emit(executionOptions, {
                type: "needs-attention",
                at: now(),
                sessionId,
                attention,
              });
              await abortSession(client, sessionId);
              return { status: "needs-attention", sessionId, attention };
            }
            return finish(
              terminalErrorResult(
                completionAuthority.error.ambiguous ? "ambiguous" : "failed",
                sessionId,
                completionAuthority.error,
              ),
            );
          }
          const completionCancellation = readCancellation();
          if (completionCancellation?.status === "cancelled") {
            return finish(
              terminalErrorResult(
                "cancelled",
                sessionId,
                typedError("execution-failed", "Scheduled execution was cancelled."),
              ),
            );
          }
          if (
            completionCancellation?.status === "unsupported"
            || completionCancellation?.status === "ambiguous"
          ) {
            return finish(
              terminalErrorResult(
                "ambiguous",
                sessionId,
                completionCancellation.error,
              ),
            );
          }
          return finish({
            status: "completed",
            sessionId,
            artifacts,
            boundedUsage: lastSnapshot.boundedUsage,
          });
        }

        if (iteration + 1 < maximumPollIterations) {
          await sleep(pollIntervalMs, executionController.signal);
        }
      }

      if (executionController.signal.aborted) {
        const cancellation = await abortSession(client, sessionId);
        if (runtimeTimedOut) {
          if (cancellation.status === "cancelled") {
            return finish(
              terminalErrorResult(
                "failed",
                sessionId,
                typedError("execution-timed-out", "Scheduled execution exceeded its runtime ceiling."),
              ),
            );
          }
          return finish(
            terminalErrorResult(
              "ambiguous",
              sessionId,
              typedError(
                "ambiguous-outcome",
                "Scheduled execution timed out, but cancellation could not be confirmed.",
                { ambiguous: true, retryable: true },
              ),
            ),
          );
        }
        if (cancellation.status === "cancelled") {
          return finish(
            terminalErrorResult(
              "cancelled",
              sessionId,
              typedError("execution-failed", "Scheduled execution was cancelled."),
            ),
          );
        }
        if (cancellation.status === "not-running") {
          try {
            const finalSnapshot = await reconcileSession(
              client,
              sessionId,
              new AbortController().signal,
            );
            if (finalSnapshot.assistantCompleted && !finalSnapshot.assistantError) {
              const finalAuthority = await inspectLiveAuthority({
                client,
                request,
                workspace,
                signal: new AbortController().signal,
                ambiguousOnFailure: true,
              });
              if (!finalAuthority.ok) {
                const attention = authorityNeedsAttention(
                  request,
                  sessionId,
                  finalAuthority.error,
                  now(),
                );
                if (attention) {
                  await emit(executionOptions, {
                    type: "needs-attention",
                    at: now(),
                    sessionId,
                    attention,
                  });
                  return { status: "needs-attention", sessionId, attention };
                }
                return finish(
                  terminalErrorResult(
                    finalAuthority.error.ambiguous ? "ambiguous" : "failed",
                    sessionId,
                    finalAuthority.error,
                  ),
                );
              }
              return finish({
                status: "completed",
                sessionId,
                artifacts: [],
                boundedUsage: finalSnapshot.boundedUsage,
              });
            }
          } catch {
            // A non-running session without a terminal snapshot remains ambiguous.
          }
        }
        return finish(
          terminalErrorResult(
            "ambiguous",
            sessionId,
            cancellation.status === "ambiguous" || cancellation.status === "unsupported"
              ? cancellation.error
              : typedError(
                  "ambiguous-outcome",
                  "Cancellation was requested after OpenCode stopped running, but no terminal outcome was available.",
                  { ambiguous: true },
                ),
          ),
        );
      }

      const cancellation = await abortSession(client, sessionId);
      return finish(
        terminalErrorResult(
          "ambiguous",
          sessionId,
          typedError(
            "ambiguous-outcome",
            cancellation.status === "cancelled"
              ? "Polling ended before a terminal OpenCode outcome was observed."
              : "Polling ended and OpenCode cancellation could not establish a terminal outcome.",
            { ambiguous: true, retryable: true },
          ),
        ),
      );
    } catch (error) {
      if (sessionId && client && !promptDispatched) {
        await abortSession(client, sessionId);
      }
      if (isAbortError(error)) {
        if (!sessionId || !client) {
          return terminalErrorResult(
            runtimeTimedOut ? "failed" : "cancelled",
            sessionId,
            typedError(
              runtimeTimedOut ? "execution-timed-out" : "execution-failed",
              runtimeTimedOut
                ? "Scheduled execution exceeded its runtime ceiling."
                : "Scheduled execution was cancelled before dispatch.",
            ),
          );
        }
        const cancellation = await abortSession(client, sessionId);
        return finish(
          terminalErrorResult(
            cancellation.status === "cancelled"
              ? runtimeTimedOut
                ? "failed"
                : "cancelled"
              : "ambiguous",
            sessionId,
            cancellation.status === "ambiguous" || cancellation.status === "unsupported"
              ? cancellation.error
              : typedError(
                  runtimeTimedOut ? "execution-timed-out" : "ambiguous-outcome",
                  runtimeTimedOut
                    ? "Scheduled execution exceeded its runtime ceiling."
                    : "Scheduled execution cancellation could not be reconciled.",
                  { ambiguous: cancellation.status !== "cancelled" },
                ),
          ),
        );
      }
      const normalized =
        error instanceof AdapterFailure
          ? error.normalized
          : typedError("internal-error", "The scheduled-task execution adapter failed.", {
              retryable: true,
              ambiguous: Boolean(sessionId && promptDispatched),
            });
      return finish(
        terminalErrorResult(
          normalized.ambiguous ? "ambiguous" : "failed",
          sessionId,
          normalized,
        ),
      );
    } finally {
      clearTimeout(runtimeTimer);
      executionOptions.signal.removeEventListener("abort", abortFromCaller);
      executionController.abort();
      if (sessionId) activeExecutions.delete(sessionId);
    }
  }

  async function cancel(
    request: ScheduledTaskCancellationRequest,
  ): Promise<ScheduledTaskCancellationResult> {
    const active = activeExecutions.get(request.sessionId);
    if (
      !active ||
      active.runId !== request.runId ||
      active.attemptId !== request.attemptId
    ) {
      return {
        status: "unsupported",
        sessionId: request.sessionId,
        error: cancellationError(
          "The adapter cannot locate this execution in the current server process.",
        ),
      };
    }
    const result = await abortSession(active.client, active.sessionId);
    active.cancellation = result;
    return result;
  }

  return { execute, cancel };
}
