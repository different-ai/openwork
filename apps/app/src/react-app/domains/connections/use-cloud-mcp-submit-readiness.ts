import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { readDenSettings } from "../../../app/lib/den";
import { recordInspectorEvent } from "../../../app/lib/app-inspector";
import type {
  OpenworkCloudMcpProviderModelContext,
  OpenworkServerClient,
} from "../../../app/lib/openwork-server";
import { denSettingsChangedEvent } from "../../../app/lib/den-session-events";
import type { DenAuthStatus } from "../cloud/den-auth-provider";
import {
  normalizeCloudMcpScope,
  readCloudMcpUserState,
} from "./cloud-mcp-user-state";
import {
  createCloudMcpSubmissionCoordinator,
  decideCloudMcpSubmissionGate,
  ensureCloudMcpSubmissionReadiness,
  IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  resolveCloudMcpSubmissionAuth,
  type CloudMcpSubmissionGateDecision,
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
  cloudAuthStatus: DenAuthStatus;
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
  const authStatusRef = useRef(input.cloudAuthStatus);
  const authWaitersRef = useRef(new Set<() => void>());
  authStatusRef.current = input.cloudAuthStatus;
  const settings = useMemo(() => readDenSettings(), [input.cloudAuthStatus, settingsVersion]);
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
    cloudAuthStatus: input.cloudAuthStatus,
    cloudHasSessionToken: Boolean(settings.authToken?.trim()),
    denBaseUrl: settings.baseUrl,
    serverBaseUrl,
    orgId: orgId || null,
    workspaceId,
    providerModel: input.providerModel,
    userState,
  }), [
    input.cloudAuthStatus,
    input.providerModel?.model,
    input.providerModel?.provider,
    orgId,
    serverBaseUrl,
    settings.authToken,
    settings.baseUrl,
    userState,
    workspaceId,
  ]);
  const currentScopeKeyRef = useRef(decision.scopeKey);
  currentScopeKeyRef.current = decision.scopeKey;
  const previousScopeKeyRef = useRef(decision.scopeKey);
  const gateSnapshot = {
    cloudAuthStatus: input.cloudAuthStatus,
    client: input.client,
    decision,
    providerModel: input.providerModel,
    settings,
    workspaceId,
  };
  const gateSnapshotRef = useRef(gateSnapshot);
  gateSnapshotRef.current = gateSnapshot;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleSettingsChanged = () => setSettingsVersion((version) => version + 1);
    window.addEventListener(denSettingsChangedEvent, handleSettingsChanged);
    return () => window.removeEventListener(denSettingsChangedEvent, handleSettingsChanged);
  }, []);

  useEffect(() => {
    if (input.cloudAuthStatus === "checking") return;
    const waiters = [...authWaitersRef.current];
    authWaitersRef.current.clear();
    for (const resolve of waiters) resolve();
  }, [input.cloudAuthStatus]);

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
    const waiters = [...authWaitersRef.current];
    authWaitersRef.current.clear();
    for (const resolve of waiters) resolve();
  }, []);

  const waitForAuthResolution = useCallback((): Promise<void> => {
    if (authStatusRef.current !== "checking") return Promise.resolve();
    return new Promise<void>((resolve) => {
      authWaitersRef.current.add(resolve);
    });
  }, []);

  const submit = useCallback(async (submission: CloudMcpSubmitInput): Promise<CloudMcpSubmissionResult> => {
    const initialSnapshot = gateSnapshotRef.current;
    const capturedScopeKey = initialSnapshot.decision.scopeKey;
    const gateRequired = !submission.skipGate && initialSnapshot.decision.mode !== "bypass";
    let prepare: (() => Promise<CloudMcpSubmissionPreparationResult>) | undefined;

    if (gateRequired) {
      prepare = async () => {
        let activeSnapshot = initialSnapshot;
        let resolvedDecision: CloudMcpSubmissionGateDecision = initialSnapshot.decision;

        if (resolvedDecision.mode === "waiting_for_auth") {
          recordInspectorEvent("cloud_mcp.submission_auth_wait", {
            workspaceId: activeSnapshot.workspaceId,
            outcome: "started",
          });
          const authResolution = await resolveCloudMcpSubmissionAuth({
            decision: resolvedDecision,
            waitForResolution: async () => {
              await waitForAuthResolution();
              return gateSnapshotRef.current.decision;
            },
          });
          if (currentScopeKeyRef.current !== capturedScopeKey) {
            return { outcome: "cancelled", reason: "context_changed" };
          }
          if (authResolution.outcome === "failed") {
            recordInspectorEvent("cloud_mcp.submission_auth_wait", {
              workspaceId: activeSnapshot.workspaceId,
              outcome: "failed",
              code: authResolution.issue.code,
            });
            if (authResolution.issue.code === "cloud_mcp_auth_resolution_timeout") {
              recordInspectorEvent("cloud_mcp.submission_timeout", {
                workspaceId: activeSnapshot.workspaceId,
                stage: "auth_resolution",
              });
            }
            return { outcome: "failed", issue: authResolution.issue };
          }

          activeSnapshot = gateSnapshotRef.current;
          resolvedDecision = authResolution.decision;
          recordInspectorEvent("cloud_mcp.submission_auth_wait", {
            workspaceId: activeSnapshot.workspaceId,
            outcome: resolvedDecision.mode,
            authStatus: activeSnapshot.cloudAuthStatus,
          });
        }

        if (resolvedDecision.mode === "bypass") return { outcome: "bypass" };
        if (resolvedDecision.mode !== "required") {
          return { outcome: "cancelled", reason: "context_changed" };
        }

        const { client, providerModel, settings, workspaceId: activeWorkspaceId } = activeSnapshot;
        if (!client || !activeWorkspaceId || !providerModel) {
          return {
            outcome: "failed",
            issue: missingContextIssue({
              client,
              workspaceId: activeWorkspaceId,
              providerModel,
            }),
          };
        }
        const result = await ensureCloudMcpSubmissionReadiness({
          providerModel,
          check: () => client.getOpenworkCloudMcpHealth(activeWorkspaceId, providerModel),
          repair: async () => {
            const repaired = await syncCloudControlMcpInBackground({
              client,
              workspaceId: activeWorkspaceId,
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
                workspaceId: activeWorkspaceId,
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
                workspaceId: activeWorkspaceId,
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
            workspaceId: initialSnapshot.workspaceId,
            provider: initialSnapshot.providerModel?.provider ?? null,
            model: initialSnapshot.providerModel?.model ?? null,
            code: nextState.issue.code,
            stage: nextState.issue.stage,
            retryable: nextState.issue.retryable,
          });
          return;
        }
        setState(IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE);
      },
    });
  }, [waitForAuthResolution]);

  return { state, submit };
}
