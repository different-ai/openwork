import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readDenSettings } from "../../../app/lib/den";
import { recordInspectorEvent } from "../../../app/lib/app-inspector";
import type {
  OpenworkCloudMcpProviderModelContext,
  OpenworkServerClient,
} from "../../../app/lib/openwork-server";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import {
  normalizeCloudMcpScope,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  createCloudMcpSubmissionCoordinator,
  decideCloudMcpSubmissionGate,
  ensureCloudMcpSubmissionReadiness,
  IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  type CloudMcpSubmissionGateState,
  type CloudMcpSubmissionIssue,
  type CloudMcpSubmissionPreparationResult,
  type CloudMcpSubmissionResult,
} from "./cloud-mcp-submit-readiness";
import {
  syncCloudControlMcpInBackground,
} from "./use-session-mcp-maintenance";

type CloudMcpSubmitReadinessClient = Pick<
  OpenworkServerClient,
  "baseUrl" | "getOpenworkCloudMcpHealth" | "reconcileOpenworkCloudMcp" | "listMcp"
>;

type UseCloudMcpSubmitReadinessInput = {
  cloudSignedIn: boolean;
  client: CloudMcpSubmitReadinessClient | null;
  workspaceId: string | null;
  providerModel?: OpenworkCloudMcpProviderModelContext;
};

type CloudMcpSubmitInput = {
  skipGate?: boolean;
  send: () => Promise<void>;
};

export type CloudMcpSubmitReadiness = {
  state: CloudMcpSubmissionGateState;
  submit: (input: CloudMcpSubmitInput) => Promise<CloudMcpSubmissionResult>;
};

function missingContextIssue(input: {
  client: CloudMcpSubmitReadinessClient | null;
  workspaceId: string;
  providerModel?: OpenworkCloudMcpProviderModelContext;
}): CloudMcpSubmissionIssue {
  if (!input.client || !input.workspaceId) {
    return {
      code: "cloud_mcp_submission_context_missing",
      stage: "engine_delivery",
      retryable: true,
      message: "OpenWork could not resolve the workspace server before checking connected service tools.",
      recommendedAction: "Retry after the workspace finishes loading.",
    };
  }
  if (!input.providerModel) {
    return {
      code: "cloud_mcp_submission_model_missing",
      stage: "provider_projection",
      retryable: false,
      message: "Select a provider and model before using connected service tools.",
      recommendedAction: "Choose a model, then Retry.",
    };
  }
  return {
    code: "cloud_mcp_submission_context_missing",
    stage: "provider_projection",
    retryable: false,
    message: "OpenWork could not verify connected service tools for this submission.",
    recommendedAction: "Retry or open Settings → Connect for diagnostics.",
  };
}

export function useCloudMcpSubmitReadiness(
  input: UseCloudMcpSubmitReadinessInput,
): CloudMcpSubmitReadiness {
  const [settingsVersion, setSettingsVersion] = useState(0);
  const [state, setState] = useState<CloudMcpSubmissionGateState>(
    IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  );
  const coordinatorRef = useRef(createCloudMcpSubmissionCoordinator());
  const settings = useMemo(() => readDenSettings(), [input.cloudSignedIn, settingsVersion]);
  const workspaceId = input.workspaceId?.trim() ?? "";
  const serverBaseUrl = input.client?.baseUrl.trim() ?? "";
  const orgId = settings.activeOrgId?.trim() ?? "";
  const scope = normalizeCloudMcpScope({
    denBaseUrl: settings.baseUrl,
    serverBaseUrl,
    orgId,
    workspaceId,
  });
  const userState = scope ? readCloudMcpUserState(scope) : null;
  const decision = useMemo(() => decideCloudMcpSubmissionGate({
    cloudSignedIn: input.cloudSignedIn,
    denBaseUrl: settings.baseUrl,
    serverBaseUrl,
    orgId: orgId || null,
    workspaceId,
    providerModel: input.providerModel,
    userState,
  }), [
    input.cloudSignedIn,
    input.providerModel?.model,
    input.providerModel?.provider,
    orgId,
    serverBaseUrl,
    settings.baseUrl,
    userState,
    workspaceId,
  ]);
  const currentScopeKeyRef = useRef(decision.scopeKey);
  currentScopeKeyRef.current = decision.scopeKey;
  const previousScopeKeyRef = useRef(decision.scopeKey);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, []);

  useEffect(() => {
    if (previousScopeKeyRef.current === decision.scopeKey) return;
    previousScopeKeyRef.current = decision.scopeKey;
    const cancelled = coordinatorRef.current.cancel("context_changed");
    setState(IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE);
    if (cancelled) {
      recordInspectorEvent("cloud_mcp.submission_cancelled", {
        workspaceId,
        reason: "context_changed",
      });
    }
  }, [decision.scopeKey, workspaceId]);

  useEffect(() => () => {
    coordinatorRef.current.cancel("unmounted");
  }, []);

  const submit = useCallback(async (submission: CloudMcpSubmitInput): Promise<CloudMcpSubmissionResult> => {
    const capturedScopeKey = decision.scopeKey;
    const gateRequired = !submission.skipGate && decision.mode === "required";
    let prepare: (() => Promise<CloudMcpSubmissionPreparationResult>) | undefined;

    if (gateRequired) {
      prepare = async () => {
        const client = input.client;
        const providerModel = input.providerModel;
        if (!client || !workspaceId || !providerModel) {
          return {
            outcome: "failed",
            issue: missingContextIssue({
              client,
              workspaceId,
              providerModel,
            }),
          };
        }
        const result = await ensureCloudMcpSubmissionReadiness({
          providerModel,
          check: () => client.getOpenworkCloudMcpHealth(workspaceId, providerModel),
          repair: async () => {
            const repaired = await syncCloudControlMcpInBackground({
              client,
              workspaceId,
              providerModel,
              settings,
              force: true,
            });
            return repaired.health;
          },
          onAttempt: (attempt) => {
            if (currentScopeKeyRef.current !== capturedScopeKey) return;
            const issue = attempt.assessment.ready ? null : attempt.assessment.issue;
            setState({
              status: attempt.phase === "readiness" ? "checking" : "repairing",
              issue,
              attempt: attempt.attempt,
              maxAttempts: attempt.maxAttempts,
            });
            recordInspectorEvent(
              attempt.phase === "readiness"
                ? "cloud_mcp.submission_readiness"
                : "cloud_mcp.submission_repair",
              {
                workspaceId,
                provider: providerModel.provider,
                model: providerModel.model,
                attempt: attempt.attempt,
                maxAttempts: attempt.maxAttempts,
                outcome: attempt.assessment.ready ? "ready" : "failed",
                code: issue?.code ?? null,
                stage: issue?.stage ?? null,
                retryable: issue?.retryable ?? null,
              },
            );
            if (issue?.code === "cloud_mcp_submission_timeout") {
              recordInspectorEvent("cloud_mcp.submission_timeout", {
                workspaceId,
                provider: providerModel.provider,
                model: providerModel.model,
                attempt: attempt.attempt,
                maxAttempts: attempt.maxAttempts,
              });
            }
          },
        });
        if (currentScopeKeyRef.current !== capturedScopeKey) {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        if (result.outcome === "ready") return { outcome: "ready" };
        if (result.outcome === "bypass") return { outcome: "bypass" };
        return { outcome: "failed", issue: result.issue };
      };
    }

    return coordinatorRef.current.submit({
      scopeKey: capturedScopeKey,
      ...(prepare ? { prepare } : {}),
      send: submission.send,
      onState: (nextState) => {
        if (currentScopeKeyRef.current !== capturedScopeKey) return;
        if (nextState.status === "checking") {
          setState({ ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE, status: "checking" });
          return;
        }
        if (nextState.status === "sending") {
          setState({ ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE, status: "sending" });
          return;
        }
        if (nextState.status === "failed") {
          setState({
            ...IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
            status: "failed",
            issue: nextState.issue,
          });
          recordInspectorEvent("cloud_mcp.submission_failure", {
            workspaceId,
            provider: input.providerModel?.provider ?? null,
            model: input.providerModel?.model ?? null,
            code: nextState.issue.code,
            stage: nextState.issue.stage,
            retryable: nextState.issue.retryable,
          });
          return;
        }
        setState(IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE);
      },
    });
  }, [decision, input.client, input.providerModel, settings, workspaceId]);

  return { state, submit };
}
