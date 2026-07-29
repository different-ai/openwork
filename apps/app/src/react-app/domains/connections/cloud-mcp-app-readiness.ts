import type { DenAuthStatus } from "../cloud/den-auth-provider";
import {
  IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  type CloudMcpSubmissionGateState,
  type CloudMcpSubmissionIssue,
} from "./cloud-mcp-submit-readiness";
import type { SessionCloudMcpMaintenanceState } from "./use-session-mcp-maintenance";

function connectionIssue(input: {
  code: string;
  message: string;
  recommendedAction: string;
}): CloudMcpSubmissionIssue {
  return {
    code: input.code,
    stage: "engine_delivery",
    retryable: true,
    message: input.message,
    recommendedAction: input.recommendedAction,
  };
}

const DEN_CONNECTION_UNAVAILABLE_ISSUE = connectionIssue({
  code: "den_connection_unavailable",
  message: "OpenWork is signed in but cannot currently connect to Den.",
  recommendedAction: "Retry, then open Settings → Connect if the problem continues.",
});

const CLOUD_MCP_CONNECTION_SKIPPED_ISSUE = connectionIssue({
  code: "cloud_mcp_connection_skipped",
  message: "OpenWork is signed in, but connected service setup did not complete for this workspace.",
  recommendedAction: "Retry or open Settings → Connect.",
});

export function deriveCloudMcpAppSubmissionState(input: {
  authStatus: DenAuthStatus;
  hasSessionToken: boolean;
  maintenance: SessionCloudMcpMaintenanceState;
}): CloudMcpSubmissionGateState {
  if (
    input.authStatus === "signed_out"
    || (input.authStatus === "checking" && !input.hasSessionToken)
  ) {
    return IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE;
  }

  if (input.authStatus === "checking") {
    return {
      status: "checking",
      issue: null,
      attempt: input.maintenance.attempt,
      maxAttempts: input.maintenance.maxAttempts,
    };
  }

  if (input.authStatus === "unavailable") {
    return {
      status: "failed",
      issue: DEN_CONNECTION_UNAVAILABLE_ISSUE,
      attempt: input.maintenance.attempt,
      maxAttempts: input.maintenance.maxAttempts,
    };
  }

  switch (input.maintenance.status) {
    case "ready":
      return IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE;
    case "retrying":
      return {
        status: "repairing",
        issue: input.maintenance.issue,
        attempt: input.maintenance.attempt,
        maxAttempts: input.maintenance.maxAttempts,
      };
    case "failed":
      return {
        status: "failed",
        issue: input.maintenance.issue ?? CLOUD_MCP_CONNECTION_SKIPPED_ISSUE,
        attempt: input.maintenance.attempt,
        maxAttempts: input.maintenance.maxAttempts,
      };
    case "skipped":
      return {
        status: "failed",
        issue: CLOUD_MCP_CONNECTION_SKIPPED_ISSUE,
        attempt: input.maintenance.attempt,
        maxAttempts: input.maintenance.maxAttempts,
      };
    case "checking":
    case "idle":
      return {
        status: "checking",
        issue: null,
        attempt: input.maintenance.attempt,
        maxAttempts: input.maintenance.maxAttempts,
      };
  }
}

export function cloudMcpAppSubmissionBlocked(
  state: CloudMcpSubmissionGateState,
): boolean {
  return state.status !== "idle" && state.status !== "sending";
}

export function cloudMcpAppSubmissionBlockedIssue(
  state: CloudMcpSubmissionGateState,
): CloudMcpSubmissionIssue {
  return state.issue ?? connectionIssue({
    code: "cloud_mcp_connection_not_ready",
    message: "OpenWork is still connecting signed-in services.",
    recommendedAction: "Wait for the connection to finish, then run the task.",
  });
}
