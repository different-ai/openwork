import type {
  OpenworkCloudMcpFailure,
  OpenworkCloudMcpHealth,
  OpenworkCloudMcpProviderModelContext,
} from "../../../app/lib/openwork-server";
import type { CloudMcpUserState } from "./cloud-mcp-user-state";

export const CLOUD_MCP_SUBMISSION_RETRY_DELAYS_MS = [1_000, 3_000];
export const CLOUD_MCP_SUBMISSION_ATTEMPT_TIMEOUT_MS = 12_000;
export const CLOUD_MCP_AUTH_RESOLUTION_TIMEOUT_MS = 12_000;

const REQUIRED_DIRECT_TOOL_IDS = ["search_capabilities", "execute_capability"];
const REQUIRED_PROJECTED_TOOL_IDS = [
  "openwork-cloud_search_capabilities",
  "openwork-cloud_execute_capability",
];

export type CloudMcpSubmissionIssue = Pick<
  OpenworkCloudMcpFailure,
  "code" | "stage" | "retryable" | "recommendedAction" | "message"
>;

export type CloudMcpSubmissionGateContext = {
  cloudAuthStatus: "checking" | "signed_in" | "unavailable" | "signed_out";
  cloudHasSessionToken: boolean;
  denBaseUrl: string;
  serverBaseUrl: string;
  orgId: string | null;
  workspaceId: string;
  providerModel?: OpenworkCloudMcpProviderModelContext;
  userState: CloudMcpUserState | null;
};

export type CloudMcpSubmissionGateDecision =
  | { mode: "required"; scopeKey: string }
  | { mode: "waiting_for_auth"; scopeKey: string }
  | {
      mode: "bypass";
      scopeKey: string;
      reason: "signed_out" | "missing_org" | "disabled";
    };

export type CloudMcpSubmissionReadinessAssessment =
  | { ready: true; health: OpenworkCloudMcpHealth }
  | { ready: false; health: OpenworkCloudMcpHealth | null; issue: CloudMcpSubmissionIssue };

export type CloudMcpSubmissionReadinessResult =
  | { outcome: "ready"; health: OpenworkCloudMcpHealth; attempts: number }
  | { outcome: "bypass"; health: OpenworkCloudMcpHealth; attempts: number; reason: "disabled" }
  | { outcome: "failed"; health: OpenworkCloudMcpHealth | null; issue: CloudMcpSubmissionIssue; attempts: number };

export type CloudMcpSubmissionAttempt = {
  phase: "readiness" | "repair";
  attempt: number;
  maxAttempts: number;
  assessment: CloudMcpSubmissionReadinessAssessment;
};

export type CloudMcpSubmissionPreparationResult =
  | { outcome: "ready" }
  | { outcome: "bypass" }
  | { outcome: "failed"; issue: CloudMcpSubmissionIssue }
  | { outcome: "cancelled"; reason: "context_changed" | "unmounted" };

export type CloudMcpSubmissionAuthResolution =
  | { outcome: "resolved"; decision: CloudMcpSubmissionGateDecision }
  | { outcome: "failed"; issue: CloudMcpSubmissionIssue };

export type CloudMcpSubmissionResult =
  | { outcome: "sent"; bypassed: boolean }
  | { outcome: "accepted" }
  | { outcome: "blocked"; issue: CloudMcpSubmissionIssue }
  | { outcome: "cancelled"; reason: "context_changed" | "unmounted" };

export type CloudMcpSubmissionGateState = {
  status: "idle" | "checking" | "repairing" | "sending" | "failed";
  issue: CloudMcpSubmissionIssue | null;
  attempt: number;
  maxAttempts: number;
};

export const IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE: CloudMcpSubmissionGateState = {
  status: "idle",
  issue: null,
  attempt: 0,
  maxAttempts: 1 + CLOUD_MCP_SUBMISSION_RETRY_DELAYS_MS.length,
};

function normalize(value: string | null | undefined): string {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

function hasEvery(values: string[], required: string[]): boolean {
  const available = new Set(values);
  return required.every((value) => available.has(value));
}

function genericSubmissionIssue(input?: {
  code?: string;
  stage?: CloudMcpSubmissionIssue["stage"];
  message?: string;
  retryable?: boolean;
  recommendedAction?: string;
}): CloudMcpSubmissionIssue {
  return {
    code: input?.code ?? "cloud_mcp_submission_readiness_failed",
    stage: input?.stage ?? "engine_delivery",
    retryable: input?.retryable ?? true,
    recommendedAction: input?.recommendedAction ?? "Retry, then open Settings → Connect if the problem continues.",
    message: input?.message ?? "OpenWork could not verify connected service tools for the selected model.",
  };
}

function failureIssue(health: OpenworkCloudMcpHealth): CloudMcpSubmissionIssue {
  const failure = health.firstFailure;
  if (!failure) return genericSubmissionIssue();
  return {
    code: failure.code,
    stage: failure.stage,
    retryable: failure.retryable,
    recommendedAction: failure.recommendedAction,
    message: failure.message,
  };
}

function healthShowsExplicitDisable(health: OpenworkCloudMcpHealth): boolean {
  const code = health.firstFailure?.code.trim().toLowerCase().replace(/[-.]/g, "_") ?? "";
  return health.desired.config?.enabled === false || code === "cloud_mcp_disabled" || code === "cloud_disabled";
}

export function cloudMcpSubmissionScopeKey(context: CloudMcpSubmissionGateContext): string {
  const cloudSessionScope = context.cloudAuthStatus === "signed_out"
    || (context.cloudAuthStatus === "checking" && !context.cloudHasSessionToken)
    ? "signed_out"
    : "cloud_session";
  return JSON.stringify([
    cloudSessionScope,
    normalize(context.denBaseUrl),
    normalize(context.serverBaseUrl),
    normalize(context.orgId),
    normalize(context.workspaceId),
    context.providerModel?.provider.trim() ?? "",
    context.providerModel?.model.trim() ?? "",
    context.userState ?? "enabled",
  ]);
}

export function decideCloudMcpSubmissionGate(
  context: CloudMcpSubmissionGateContext,
): CloudMcpSubmissionGateDecision {
  const scopeKey = cloudMcpSubmissionScopeKey(context);
  if (
    context.cloudAuthStatus === "signed_out"
    || (context.cloudAuthStatus === "checking" && !context.cloudHasSessionToken)
  ) {
    return { mode: "bypass", scopeKey, reason: "signed_out" };
  }
  if (context.cloudAuthStatus === "checking") {
    if (context.userState) return { mode: "bypass", scopeKey, reason: "disabled" };
    return { mode: "waiting_for_auth", scopeKey };
  }
  if (!context.orgId?.trim()) return { mode: "bypass", scopeKey, reason: "missing_org" };
  if (context.userState) return { mode: "bypass", scopeKey, reason: "disabled" };
  return { mode: "required", scopeKey };
}

function authResolutionIssue(input?: { timedOut?: boolean }): CloudMcpSubmissionIssue {
  return genericSubmissionIssue({
    code: input?.timedOut
      ? "cloud_mcp_auth_resolution_timeout"
      : "cloud_mcp_auth_resolution_failed",
    message: input?.timedOut
      ? "OpenWork timed out while restoring connected service access."
      : "OpenWork could not finish restoring connected service access.",
    recommendedAction: "Retry or open Settings → Connect.",
  });
}

export async function resolveCloudMcpSubmissionAuth(
  input: {
    decision: CloudMcpSubmissionGateDecision;
    waitForResolution: () => Promise<CloudMcpSubmissionGateDecision>;
    timeoutMs?: number;
  },
): Promise<CloudMcpSubmissionAuthResolution> {
  if (input.decision.mode !== "waiting_for_auth") {
    return { outcome: "resolved", decision: input.decision };
  }

  try {
    const decision = await withTimeout(
      input.waitForResolution,
      input.timeoutMs ?? CLOUD_MCP_AUTH_RESOLUTION_TIMEOUT_MS,
    );
    if (decision.mode === "waiting_for_auth") {
      return { outcome: "failed", issue: authResolutionIssue() };
    }
    return { outcome: "resolved", decision };
  } catch (error) {
    const timedOut = error instanceof Error
      && error.message === "cloud_mcp_submission_timeout";
    return { outcome: "failed", issue: authResolutionIssue({ timedOut }) };
  }
}

/**
 * A connected MCP transport and generic model tool-calling support are not
 * evidence that the selected provider/model received these two MCP tools.
 * The strongest honest proof available today is the provider/model-scoped
 * OpenCode experimental tool listing plus the direct MCP tools/list probe.
 */
export function assessCloudMcpSubmissionReadiness(input: {
  health: OpenworkCloudMcpHealth | null;
  providerModel: OpenworkCloudMcpProviderModelContext;
}): CloudMcpSubmissionReadinessAssessment {
  const health = input.health;
  if (!health) {
    return { ready: false, health: null, issue: genericSubmissionIssue() };
  }
  if (!health.usable) {
    return { ready: false, health, issue: failureIssue(health) };
  }
  if (
    health.engine.status !== "connected" ||
    !health.tools.direct.checked ||
    !hasEvery(health.tools.direct.present, REQUIRED_DIRECT_TOOL_IDS) ||
    health.tools.direct.missing.length > 0
  ) {
    return {
      ready: false,
      health,
      issue: genericSubmissionIssue({
        code: "cloud_mcp_direct_tools_unverified",
        stage: "tool_registration",
        message: "OpenWork Cloud did not prove that search_capabilities and execute_capability are available.",
      }),
    };
  }

  const projection = health.tools.providerProjection;
  if (
    projection.provider !== input.providerModel.provider ||
    projection.model !== input.providerModel.model
  ) {
    return {
      ready: false,
      health,
      issue: genericSubmissionIssue({
        code: "cloud_mcp_submission_context_mismatch",
        stage: "provider_projection",
        message: "Connected service tools were checked for a different provider or model.",
      }),
    };
  }
  if (!projection.checked || projection.source !== "experimental_tool") {
    return {
      ready: false,
      health,
      issue: genericSubmissionIssue({
        code: "provider_tool_projection_unverified",
        stage: "provider_projection",
        retryable: false,
        message: "The current engine cannot prove that connected service tools were injected into the selected model.",
        recommendedAction: "Update or restart OpenWork, then Retry. Open Connect for detailed diagnostics.",
      }),
    };
  }
  if (
    health.usableByCurrentModel !== true ||
    !hasEvery(projection.present, REQUIRED_PROJECTED_TOOL_IDS) ||
    projection.missing.length > 0
  ) {
    return {
      ready: false,
      health,
      issue: genericSubmissionIssue({
        code: "provider_tool_projection_missing",
        stage: "provider_projection",
        retryable: false,
        message: "The selected model is missing search_capabilities or execute_capability.",
        recommendedAction: "Choose a compatible model or open Settings → Connect for diagnostics.",
      }),
    };
  }
  return { ready: true, health };
}

function timeoutIssue(): CloudMcpSubmissionIssue {
  return genericSubmissionIssue({
    code: "cloud_mcp_submission_timeout",
    message: "OpenWork timed out while preparing connected service tools.",
  });
}

async function withTimeout<T>(task: () => Promise<T>, timeoutMs: number): Promise<T> {
  if (timeoutMs <= 0) return task();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("cloud_mcp_submission_timeout")), timeoutMs);
  });
  try {
    return await Promise.race([task(), timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function errorAssessment(error: unknown): CloudMcpSubmissionReadinessAssessment {
  const timedOut = error instanceof Error && error.message === "cloud_mcp_submission_timeout";
  return {
    ready: false,
    health: null,
    issue: timedOut
      ? timeoutIssue()
      : genericSubmissionIssue({
          code: "cloud_mcp_submission_check_failed",
          message: "OpenWork could not check connected service tools before sending.",
        }),
  };
}

export async function ensureCloudMcpSubmissionReadiness(input: {
  providerModel: OpenworkCloudMcpProviderModelContext;
  check: () => Promise<OpenworkCloudMcpHealth | null>;
  repair: () => Promise<OpenworkCloudMcpHealth | null>;
  retryDelaysMs?: number[];
  attemptTimeoutMs?: number;
  wait?: (delayMs: number) => Promise<void>;
  onAttempt?: (attempt: CloudMcpSubmissionAttempt) => void;
}): Promise<CloudMcpSubmissionReadinessResult> {
  const retryDelaysMs = input.retryDelaysMs ?? CLOUD_MCP_SUBMISSION_RETRY_DELAYS_MS;
  const maxAttempts = 1 + retryDelaysMs.length;
  const timeoutMs = input.attemptTimeoutMs ?? CLOUD_MCP_SUBMISSION_ATTEMPT_TIMEOUT_MS;
  const wait = input.wait ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  let lastAssessment: CloudMcpSubmissionReadinessAssessment = {
    ready: false,
    health: null,
    issue: genericSubmissionIssue(),
  };

  for (let index = 0; index < maxAttempts; index += 1) {
    const phase = index === 0 ? "readiness" : "repair";
    if (index > 0) await wait(retryDelaysMs[index - 1] ?? 0);
    try {
      const health = await withTimeout(index === 0 ? input.check : input.repair, timeoutMs);
      if (health && healthShowsExplicitDisable(health)) {
        return { outcome: "bypass", health, attempts: index + 1, reason: "disabled" };
      }
      lastAssessment = assessCloudMcpSubmissionReadiness({ health, providerModel: input.providerModel });
    } catch (error) {
      lastAssessment = errorAssessment(error);
    }
    input.onAttempt?.({ phase, attempt: index + 1, maxAttempts, assessment: lastAssessment });
    if (lastAssessment.ready) {
      return { outcome: "ready", health: lastAssessment.health, attempts: index + 1 };
    }
    if (!lastAssessment.issue.retryable || index === maxAttempts - 1) {
      return {
        outcome: "failed",
        health: lastAssessment.health,
        issue: lastAssessment.issue,
        attempts: index + 1,
      };
    }
  }

  return {
    outcome: "failed",
    health: lastAssessment.health,
    issue: lastAssessment.ready ? genericSubmissionIssue() : lastAssessment.issue,
    attempts: maxAttempts,
  };
}

type SubmissionCoordinatorState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "sending" }
  | { status: "failed"; issue: CloudMcpSubmissionIssue }
  | { status: "cancelled"; reason: "context_changed" | "unmounted" };

type SubmissionCoordinatorInput = {
  scopeKey: string;
  prepare?: () => Promise<CloudMcpSubmissionPreparationResult>;
  send: () => Promise<void>;
  onState?: (state: SubmissionCoordinatorState) => void;
};

type ActiveSubmission = {
  id: number;
  scopeKey: string;
  promise: Promise<CloudMcpSubmissionResult>;
  cancel: (reason: "context_changed" | "unmounted") => void;
  onState?: (state: SubmissionCoordinatorState) => void;
};

export type CloudMcpSubmissionCoordinator = {
  submit: (input: SubmissionCoordinatorInput) => Promise<CloudMcpSubmissionResult>;
  cancel: (reason: "context_changed" | "unmounted") => boolean;
};

export function createCloudMcpSubmissionCoordinator(): CloudMcpSubmissionCoordinator {
  let active: ActiveSubmission | null = null;
  let nextId = 0;

  const cancel = (reason: "context_changed" | "unmounted"): boolean => {
    if (!active) return false;
    const current = active;
    active = null;
    current.onState?.({ status: "cancelled", reason });
    current.cancel(reason);
    return true;
  };

  const submit = (input: SubmissionCoordinatorInput): Promise<CloudMcpSubmissionResult> => {
    if (active?.scopeKey === input.scopeKey) return active.promise;
    if (active) cancel("context_changed");

    const id = ++nextId;
    let resolveCancellation: ((result: CloudMcpSubmissionPreparationResult) => void) | null = null;
    const cancellation = new Promise<CloudMcpSubmissionPreparationResult>((resolve) => {
      resolveCancellation = resolve;
    });
    if (input.prepare) input.onState?.({ status: "checking" });
    const preparation = input.prepare?.() ?? Promise.resolve<CloudMcpSubmissionPreparationResult>({ outcome: "bypass" });

    const task = (async (): Promise<CloudMcpSubmissionResult> => {
      const prepared = await Promise.race([preparation, cancellation]);
      if (prepared.outcome === "cancelled") return prepared;
      if (prepared.outcome === "failed") {
        input.onState?.({ status: "failed", issue: prepared.issue });
        return { outcome: "blocked", issue: prepared.issue };
      }
      if (active?.id !== id) return { outcome: "cancelled", reason: "context_changed" };
      input.onState?.({ status: "sending" });
      try {
        await input.send();
        input.onState?.({ status: "idle" });
        return { outcome: "sent", bypassed: prepared.outcome === "bypass" };
      } catch (error) {
        input.onState?.({ status: "idle" });
        throw error;
      }
    })().finally(() => {
      if (active?.id === id) active = null;
    });

    active = {
      id,
      scopeKey: input.scopeKey,
      promise: task,
      cancel: (reason) => {
        resolveCancellation?.({ outcome: "cancelled", reason });
      },
      ...(input.onState ? { onState: input.onState } : {}),
    };
    return task;
  };

  return { submit, cancel };
}
