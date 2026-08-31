/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "@/components/ui/sonner";
import type { ProviderListResponse } from "@opencode-ai/sdk/v2/client";

import { captureAnalyticsEvent, markTaskRunStart } from "@/app/lib/analytics";
import { trackSessionActive, trackTaskStarted } from "@/app/lib/den-telemetry";
import { buildDiagnosticsBundleJson } from "@/app/lib/diagnostics-bundle";
import { downloadTextAsFile } from "@/app/lib/download";
import { canCreateWorkspaces } from "@/app/lib/workspace-creation-policy";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe, forkSession, listCommands, revertSession, setSessionArchived, shellInSession, unrevertSession } from "@/app/lib/opencode-session";
import { deleteNativeSession, getNativeSessionMessages } from "@/app/lib/opencode-session-native";
import { useSessionManagementStore as sessionManagementStore } from "@/react-app/domains/session/sidebar/session-management-store";
import {
  buildOpenworkWorkspaceBaseUrl,
  readOpenworkServerSettings,
} from "@/app/lib/openwork-server";
import {
  workspaceServerId,
  type ResolvedWorkspaceEndpoint,
} from "@/app/lib/workspace-endpoint";
import { buildOpenworkEnvRuntimeKey } from "@/app/lib/openwork-env-runtime";
import {
  getDesktopHomeDir,
  joinDesktopPath,
  revealDesktopItemInDir,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreateRemote,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type OpenworkServerInfo,
  type WorkspaceInfo,
  type WorkspaceList,
} from "@/app/lib/desktop";
import type {
  ComposerAttachment,
  ComposerDraft,
  ModelOption,
  ModelRef,
  SlashCommandOption,
  WorkspacePreset,
  WorkspaceConnectionState,
  Client,
  ProviderListItem,
  WorkspaceDisplay,
  WorkspaceSessionGroup,
} from "@/app/types";
import { buildFeedbackUrl } from "@/app/lib/feedback";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isDesktopRuntime,
  isSandboxWorkspace,
  normalizeDirectoryPath,
  normalizeSessionStatus,
  resolveModelDisplayName,
  safeStringify,
} from "@/app/utils";
import { t } from "@/i18n";
import {
  type RouteWorkspace,
  type RouteSession,
  describeRouteError,
  describeWorkspaceCreateError,
  downloadWorkspaceJson,
  folderNameFromPath,
  getSessionStatus,
  isActiveSessionStatus,
  isTransientStartupError,
  mapDesktopWorkspace,
  mergeRouteWorkspaces,
  orderRouteWorkspaces,
  toSessionGroups,
  workspaceExportFilename,
  workspaceLabel,
} from "@/react-app/shell/route-workspaces";
import { useLocal } from "@/react-app/kernel/local-provider";
import { usePlatform } from "@/react-app/kernel/platform";
import {
  SessionPage,
  type OpenSessionTab,
  type SessionPagePaneRuntime,
} from "@/react-app/domains/session/chat/session-page";
import { AutomationsPage } from "@/react-app/domains/automations/automations-page";
import { DashboardPage } from "@/react-app/domains/dashboard/dashboard-page";
import { useDashboardDeploymentAvailability } from "@/react-app/domains/dashboard/dashboard-availability";
import { useAutomationDeploymentEnabled } from "@/react-app/domains/automations/automation-availability";
import { automationsStateChangedEvent } from "@/react-app/domains/automations/automation-events";
import type { NewTaskComposerContext } from "@/react-app/domains/session/chat/new-task-composer";
import { isDesktopProviderBlocked } from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { ReactSessionRuntime } from "@/react-app/domains/session/sync/runtime-sync";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { buildOpenworkEnvSystemContext } from "@/react-app/domains/session/sync/env-context";
import {
  applySessionRevert,
  applySessionUnrevert,
} from "@/react-app/domains/session/sync/session-sync";
import { draftToParts } from "@/react-app/domains/session/sync/draft-parts";
import { useSessionInteractions } from "@/react-app/domains/session/sync/use-session-interactions";
import { useModelBehavior } from "@/react-app/domains/session/surface/use-model-behavior";
import { getModelBehaviorSummary, nextModelBehaviorValue, previousModelBehaviorValue } from "@/app/lib/model-behavior";
import { computeModelAvailability, createUnavailableConfirmationGate, type ModelAvailability } from "@/react-app/domains/session/surface/model-availability";
import { useSessionFindStore } from "@/react-app/domains/session/surface/find-store";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import { getSessionModelSelection, useSessionModelStore } from "@/react-app/domains/session/surface/session-model-store";
import { useWorkbenchStore } from "@/react-app/domains/session/chat/workbench-store";
import { resolveWorkbenchPaneEndpoint } from "@/react-app/domains/session/chat/pane-runtime";
import {
  nextFavoriteModel,
  useModelCollectionsStore,
} from "@/react-app/domains/session/models/model-collections-store";
import { openModelPickerEvent, openProviderAuthEvent } from "@/react-app/shell/new-providers-listener";
import { markComposerAutoSend } from "@/react-app/domains/session/surface/composer-auto-send";
import { sendWithRevertRollback } from "@/react-app/domains/session/surface/safe-edit-resend";
import { CreateRemoteWorkspaceModal } from "@/react-app/domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "@/react-app/domains/workspace/types";
import { isCloudManagedProviderKey } from "@/react-app/domains/connections/provider-auth/cloud-provider-config";
import { assignedModelOptions } from "@/react-app/domains/connections/provider-auth/assigned-model-options";
import {
  filterEntitledModelOptions,
  resolveEntitledOrgDefaultModel,
  type ModelEntitlementOption,
} from "@/react-app/domains/connections/provider-auth/provider-policy";
import {
  isOrganizationModelsEmpty,
  shouldAutoOpenUnavailableModelPicker,
} from "@/react-app/domains/connections/provider-auth/managed-models-recovery";
import { useSessionProviderAuth } from "@/react-app/domains/connections/provider-auth/use-session-provider-auth";
import {
  disabledProvidersFromConfig,
  updateManagedDisabledProviders,
} from "@/react-app/domains/connections/managed-engine-config";
import { useMcpConnectedCount } from "@/react-app/domains/connections/use-mcp-connected-count";
import { useSessionMcpMaintenance } from "@/react-app/domains/connections/use-session-mcp-maintenance";
import { useCloudMcpSubmitReadiness } from "@/react-app/domains/connections/use-cloud-mcp-submit-readiness";
import {
  IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
  type CloudMcpSubmissionResult,
} from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { useRemoteAccessRestart } from "@/react-app/domains/workspace/remote-access-restart";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { useRemoteWorkspaceConnectionEditor } from "@/react-app/domains/workspace/use-remote-workspace-connection-editor";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import {
  hasOpenWorkModelsAvailable,
  shouldShowOpenWorkModelsSyncing,
} from "@/react-app/domains/cloud/openwork-models-promo";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { useShareWorkspaceState } from "@/react-app/domains/workspace/share-workspace-state";
import { ModelPickerModal, MODEL_PICKER_UNAVAILABLE_SUBTITLE } from "@/react-app/domains/session/modals/model-picker-modal";
import { CommandPalette, type PaletteItem, type SessionGroupOption } from "./command-palette";
import { buildCommandPaletteSessions } from "./command-palette-sessions";
import type { ThinkingModeShortcutDirection } from "./thinking-mode-shortcut";
import { SessionSearchDialog } from "./session-search-dialog";
import type { SessionMessageFetcher } from "@/react-app/domains/session/search/session-search";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readLastSessionFor,
  readWorkspaceProjectDimension,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
  writeLastSessionFor,
  writeWorkspaceProjectDimension,
  writeWorkspaceOrderIds,
} from "./session-memory";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "../../app/lib/app-inspector";
import {
  resolveSessionDraftScope,
  saveSessionDraft,
  sessionDraftScopeKey,
} from "@/react-app/domains/session/sync/draft-store";
import {
  claimComposerSessionDraftScope,
  useComposerStateStore,
} from "@/react-app/domains/session/surface/composer-state-store";
import { useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { useReactRenderWatchdog } from "./react-render-watchdog";
import { useBootOverlayVisible } from "./boot-state";

import {
  createDenClient,
  isDenOrgAdminRole,
  readDenSettings,
  type DenOrgRole,
} from "@/app/lib/den";
import { denSessionUpdatedEvent, denSettingsChangedEvent } from "@/app/lib/den-session-events";

import { filterProviderList } from "@/app/utils/providers";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import { useReloadCoordinator } from "./reload-coordinator";
import { useShellConfig } from "./shell-config";
import { useShellShortcuts } from "./use-shell-shortcuts";
import { useEngineReload } from "./use-engine-reload";
import { useSessionGroupSync } from "./use-session-group-sync";
import { useWorkspaceRouteState } from "./use-workspace-route-state";
import { CloudWorkspaceBootTakeover, useCloudWorkspaceStatus } from "./cloud-workspace-overlay";
import {
  cloudWorkspaceStatusHasReadyContent,
  mapCloudWorkspaceMainContentDecision,
  shouldRefetchCloudWorkspaceOnReadyTransition,
} from "./cloud-workspace-status";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useSessionControlActions } from "@/react-app/domains/session/control/session-control-actions";
import { openComposerConfigure, isLibraryAgent, type ComposerSettingsSection } from "@/react-app/domains/settings/library";
import {
  globalExtensionsRoute,
  legacySessionRoute,
  automationsRoute,
  dashboardRoute,
  workspaceExtensionsRoute,
  workspaceSessionRoute,
  workspaceSettingsRoute,
} from "./workspace-routes";
import { WorkspaceProvider } from "./workspace-provider";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { SettingsSurface } from "./settings-route";
import { writeStoredDefaultModel } from "@/react-app/kernel/model-config";
import {
  ensureProviderListQuery,
  getConnectedProviderItems,
  refreshProviderListQueries,
  useProviderListQuery,
} from "@/react-app/infra/provider-list-query";

/**
 * Serialize an SDK error value into a string that parseSessionError can parse.
 * Preserves the original shape (name, data, message) as JSON when possible,
 * so the session surface can detect ProviderModelNotFoundError and offer
 * recovery actions like "Change model".
 */
function serializeSDKError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      const msg = (error as Record<string, unknown>).message;
      return typeof msg === "string" ? msg : String(error);
    }
  }
  return String(error);
}

function describeTaskCreateError(error: unknown) {
  const message = describeRouteError(error);
  let serializedCode: unknown = null;
  try {
    const payload: unknown = JSON.parse(message);
    serializedCode = typeof payload === "object" && payload !== null
      ? Reflect.get(payload, "code")
      : null;
  } catch {
    // The normal error path is plain text, not a wire payload.
  }
  const directCode = typeof error === "object" && error !== null
    ? Reflect.get(error, "code")
    : null;
  const code = typeof directCode === "string" ? directCode : serializedCode;
  if (code === "opencode_unconfigured") {
    return "Choose a model for this workspace, then try again.";
  }
  const lower = message.toLowerCase();
  if (
    lower.includes("failed to fetch") ||
    lower.includes("connection") ||
    lower.includes("fetch failed") ||
    lower.includes("econnrefused") ||
    lower.includes("connection lost") ||
    lower.includes("internal_error") ||
    lower.includes("unexpected server error")
  ) {
    return "OpenCode is unavailable for this workspace. Retry once it restarts, or restart OpenWork if the problem continues.";
  }
  return message;
}

function providerListModelEntitlementOptions(
  providerList: ProviderListResponse | null | undefined,
): ModelEntitlementOption[] {
  return getConnectedProviderItems(providerList).flatMap((provider) =>
    Object.keys(provider.models ?? {}).map((modelID) => ({
      providerID: provider.id,
      modelID,
    })),
  );
}

function taskCreateUnavailableToastId(workspaceId: string) {
  return `opencode-unavailable:${workspaceId}`;
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("openwork:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

const EVAL_UNAVAILABLE_PROVIDER_ID = "eval-unavailable-provider";

function nextEvalUnavailableModel(current: ModelRef | null | undefined) {
  return {
    providerID: EVAL_UNAVAILABLE_PROVIDER_ID,
    modelID: current?.providerID === EVAL_UNAVAILABLE_PROVIDER_ID && current.modelID === "eval-unavailable-model-a"
      ? "eval-unavailable-model-b"
      : "eval-unavailable-model-a",
  } satisfies ModelRef;
}

function singlePickedDirectory(selection: string | string[] | null) {
  return typeof selection === "string"
    ? selection
    : Array.isArray(selection)
      ? selection[0] ?? null
      : null;
}

export function SessionRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const automationsRouteRequested = /^\/automations(?:\/|$)/.test(location.pathname);
  const dashboardRouteRequested = /^\/dashboard(?:\/|$)/.test(location.pathname);
  const {
    enabled: mcpAppsDashboardEnabled,
    loading: dashboardAvailabilityLoading,
  } = useDashboardDeploymentAvailability();
  const dashboardRouteActive = mcpAppsDashboardEnabled && dashboardRouteRequested;
  const dashboardWorkspaceRoute = dashboardRouteRequested
    && (dashboardAvailabilityLoading || mcpAppsDashboardEnabled);
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const { config: shellConfig } = useShellConfig();
  const local = useLocal();
  const automationDeploymentEnabled = useAutomationDeploymentEnabled();
  const automationsEnabled = isDesktopRuntime() && automationDeploymentEnabled;
  const automationsRouteActive = automationsEnabled && automationsRouteRequested;
  const denSettings = readDenSettings();
  const sessionDraftScope = resolveSessionDraftScope({
    hasCloudCredential: Boolean(denSettings.authToken?.trim()),
    verifiedIdentity: denAuth.verifiedIdentity,
  });
  const [automationsSupported, setAutomationsSupported] = useState(false);
  const [automationsNeedAttention, setAutomationsNeedAttention] = useState(false);
  useEffect(() => {
    if (!automationsRouteRequested || automationsEnabled) return;
    navigate("/", { replace: true });
  }, [automationsEnabled, automationsRouteRequested, navigate]);
  useEffect(() => {
    if (!dashboardRouteRequested || dashboardAvailabilityLoading || mcpAppsDashboardEnabled) return;
    navigate("/", { replace: true });
  }, [dashboardAvailabilityLoading, dashboardRouteRequested, mcpAppsDashboardEnabled, navigate]);
  useEffect(() => {
    const authToken = denSettings.authToken?.trim();
    const organizationId = denSettings.activeOrgId?.trim();
    if (!automationsEnabled || !denAuth.isSignedIn || !authToken || !organizationId) {
      setAutomationsSupported(false);
      setAutomationsNeedAttention(false);
      return;
    }
    let cancelled = false;
    const client = createDenClient({ baseUrl: denSettings.baseUrl, token: authToken });
    const refreshAutomationState = () => {
      void client.listAutomations(organizationId, { limit: 100 })
        .then((result) => {
          if (cancelled) return;
          setAutomationsSupported(true);
          setAutomationsNeedAttention(result.items.some((item) => item.automation.state === "needs_attention"));
        })
        .catch(() => {
          if (cancelled) return;
          setAutomationsSupported(false);
          setAutomationsNeedAttention(false);
        });
    };
    refreshAutomationState();
    const interval = window.setInterval(refreshAutomationState, 5 * 60_000);
    window.addEventListener(automationsStateChangedEvent, refreshAutomationState);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener(automationsStateChangedEvent, refreshAutomationState);
    };
  }, [
    automationsEnabled,
    denAuth.isSignedIn,
    denAuth.status,
    denSettings.activeOrgId,
    denSettings.authToken,
    denSettings.baseUrl,
  ]);
  const automationsNavigationAvailable = automationsEnabled && automationsSupported;
  const reloadCoordinator = useReloadCoordinator();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const [activeOrganizationRole, setActiveOrganizationRole] = useState<DenOrgRole | null>(null);
  const [openworkServerHostInfoState, setOpenworkServerHostInfoState] = useState<OpenworkServerInfo | null>(null);
  const [openworkServerSettingsVersion, setOpenworkServerSettingsVersion] = useState(0);

  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("openwork.developerMode") === "1";
  });
  const {
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    loading,
    effectiveLoading,
    client,
    baseUrl,
    token,
    workspaces,
    setWorkspaces,
    workspacesRef,
    workspaceOrderIds,
    setWorkspaceOrderIds,
    workspaceOrderIdsRef,
    sessionsByWorkspaceId,
    setSessionsByWorkspaceId,
    sessionsByWorkspaceIdRef,
    errorsByWorkspaceId,
    setErrorsByWorkspaceId,
    workspaceConnectionOverrides,
    routeError,
    setRouteError,
    legacySelectedWorkspaceId,
    setLegacySelectedWorkspaceId,
    retryingWorkspaceIds,
    setRetryingWorkspaceIds,
    startupRetryTimerRef,
    selectedWorkspaceId,
    selectedWorkspace,
    selectedWorkspaceRoot,
    selectedWorkspaceEndpoint,
    selectedWorkspaceServerToken,
    opencodeBaseUrl,
    opencodeClient,
    selectedWorkspaceIsLoading,
    selectedWorkspaceError,
    routeNotFoundMessage,
    endpointForWorkspace,
    refreshRouteState,
    reloadWorkspaceSessions,
    rememberPendingCreatedSession,
    handleRuntimeSessionCreated,
    handleRuntimeSessionUpdated,
    handleRuntimeSessionDeleted,
    handleRemoteWorkspaceConnectionSaved,
    runRemoteWorkspaceConnectionCheck,
  } = useWorkspaceRouteState({
    developerMode,
    workspaceRoute: automationsRouteActive ? "automations" : dashboardWorkspaceRoute ? "dashboard" : "session",
    onServerSettingsChanged: () => setOpenworkServerSettingsVersion((value) => value + 1),
    onHostInfo: setOpenworkServerHostInfoState,
  });
  // The dashboard is user-scoped while MCP servers are workspace-scoped: the
  // selected workspace's runtime is primary, and every other available one is
  // a per-tile fallback so tiles keep working when the selected workspace does
  // not configure their server.
  const dashboardEndpoints = useMemo(() => {
    if (!dashboardRouteActive) return [];
    const endpoints: ResolvedWorkspaceEndpoint[] = [];
    if (selectedWorkspaceEndpoint) endpoints.push(selectedWorkspaceEndpoint);
    for (const workspace of workspaces) {
      const endpoint = endpointForWorkspace(workspace);
      if (endpoint && !endpoints.some((existing) => existing.workspaceId === endpoint.workspaceId)) {
        endpoints.push(endpoint);
      }
    }
    return endpoints;
  }, [dashboardRouteActive, endpointForWorkspace, selectedWorkspaceEndpoint, workspaces]);
  const dashboardEndpoint = dashboardEndpoints[0] ?? null;
  const dashboardFallbackEndpoints = useMemo(
    () => dashboardEndpoints.slice(1).map((endpoint) => ({
      client: endpoint.client,
      workspaceId: endpoint.workspaceId,
    })),
    [dashboardEndpoints],
  );
  const cloudWorkspace = useCloudWorkspaceStatus();
  const bootOverlayVisible = useBootOverlayVisible();
  const previousCloudWorkspaceStatusRef = useRef<typeof cloudWorkspace.viewModel.variant | null>(null);
  useEffect(() => {
    const previousStatus = previousCloudWorkspaceStatusRef.current;
    previousCloudWorkspaceStatusRef.current = cloudWorkspace.viewModel.variant;
    if (!shouldRefetchCloudWorkspaceOnReadyTransition({
      previousStatus,
      nextStatus: cloudWorkspace.viewModel.variant,
      gatewayMode: cloudWorkspace.gatewayMode && cloudWorkspace.visible,
    })) return;
    void refreshRouteState({ supersede: true });
  }, [cloudWorkspace.gatewayMode, cloudWorkspace.viewModel.variant, cloudWorkspace.visible, refreshRouteState]);
  const cloudMcpProviderModel = useMemo(() => local.prefs.defaultModel
    ? {
        provider: local.prefs.defaultModel.providerID,
        model: local.prefs.defaultModel.modelID,
      }
    : undefined, [local.prefs.defaultModel?.modelID, local.prefs.defaultModel?.providerID]);
  const sessionMcpMaintenance = useSessionMcpMaintenance({
    cloudSignedIn: denAuth.isSignedIn,
    client: selectedWorkspaceEndpoint?.client ?? null,
    workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
    opencodeClient,
    directory: selectedWorkspaceRoot,
    engineReloadBusy: reloadCoordinator.reloadBusy,
    providerModel: cloudMcpProviderModel,
  });
  const {
    state: cloudMcpSubmissionState,
    submit: submitWithCloudMcpReadiness,
    clearFailure: clearCloudMcpSubmissionFailure,
  } = useCloudMcpSubmitReadiness({
    cloudAuthStatus: denAuth.status,
    client: selectedWorkspaceEndpoint?.client ?? null,
    workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
    providerModel: cloudMcpProviderModel,
  });
  // Agent selection is persisted in local prefs (like the model variant) so
  // it survives reloads instead of silently falling back to "build" (#2101).
  const selectedAgent = local.prefs.selectedAgent;
  const setSelectedAgent = useCallback(
    (agent: string | null) => {
      local.setPrefs((previous) => ({ ...previous, selectedAgent: agent }));
    },
    [local.setPrefs],
  );
  // One-way latch for "a refreshRouteState is currently running"; prevents
  // overlapping route refreshes from queueing up when the user clicks fast.
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [paletteAccessibleTargets, setPaletteAccessibleTargets] = useState<OpenTarget[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [disabledProviderIds, setDisabledProviderIds] = useState<string[]>([]);
  // Bump to re-filter provider list when den session changes (sign-in/out)
  const [denSessionVersion, setDenSessionVersion] = useState(0);
  useEffect(() => {
    const handler = () => setDenSessionVersion((v) => v + 1);
    window.addEventListener(denSessionUpdatedEvent, handler);
    window.addEventListener(denSettingsChangedEvent, handler);
    return () => {
      window.removeEventListener(denSessionUpdatedEvent, handler);
      window.removeEventListener(denSettingsChangedEvent, handler);
    };
  }, []);

  // Provider IDs that were just added — used to highlight them as
  useEffect(() => {
    setPaletteAccessibleTargets([]);
  }, [selectedSessionId, selectedWorkspaceId]);

  // Provider catalog cache. Used to compute the reasoning/thinking variant
  // options for whichever model is currently selected so the composer's
  // behavior pill actually shows its options (bug: was empty before).

  const openworkServerSettings = useMemo(
    () => readOpenworkServerSettings(),
    [openworkServerSettingsVersion],
  );

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session) => {
          if (!isActiveSessionStatus(getSessionStatus(session))) return [];
          const id = String(session?.id ?? "");
          if (!id) return [];
          return [{
            id,
            title:
              String(session?.title ?? session?.slug ?? session?.id ?? "").trim() ||
              t("session.untitled"),
          }];
        }),
    [sessionsByWorkspaceId],
  );
  const activeSelectedWorkspaceSessionIds = useMemo(
    () =>
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).flatMap((session) => {
        if (!isActiveSessionStatus(getSessionStatus(session))) return [];
        const id = String(session?.id ?? "").trim();
        return id ? [id] : [];
      }),
    [selectedWorkspaceId, sessionsByWorkspaceId],
  );
  const remoteAccessRestart = useRemoteAccessRestart({
    isEnabled: () => openworkServerSettings.remoteAccessEnabled === true,
    onHostInfo: setOpenworkServerHostInfoState,
    onSettingsChanged: () => setOpenworkServerSettingsVersion((value) => value + 1),
  });

  const { engineReloadVersion, routeEngineInfo, reloadWorkspaceEngineFromUi } = useEngineReload({
    client,
    workspaceId: selectedWorkspaceId,
    workspace: selectedWorkspace,
    endpointForWorkspace,
    activeReloadBlockingSessions,
    onError: setRouteError,
    refreshRouteState,
  });

  const environmentRuntimeKey = useMemo(
    () => buildOpenworkEnvRuntimeKey({
      baseUrl: client?.baseUrl ?? null,
      pid: openworkServerHostInfoState?.pid ?? null,
      port: openworkServerHostInfoState?.port ?? null,
    }),
    [client?.baseUrl, openworkServerHostInfoState?.pid, openworkServerHostInfoState?.port],
  );

  const handleApplyEnvironmentChanges = useCallback(async () => {
    if (!isDesktopRuntime()) {
      throw new Error(t("settings.environment.apply_unavailable"));
    }
    if (activeReloadBlockingSessions.length > 0) {
      throw new Error(t("settings.environment.apply_blocked_active_tasks"));
    }
    if (!selectedWorkspaceRoot) {
      throw new Error(t("settings.environment.apply_no_local_workspace"));
    }
    const reloaded = await reloadWorkspaceEngineFromUi();
    if (!reloaded) {
      throw new Error(t("app.error_connect_first"));
    }
  }, [activeReloadBlockingSessions.length, reloadWorkspaceEngineFromUi, selectedWorkspaceRoot]);

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    openworkServerHostInfo: openworkServerHostInfoState,
    openworkServerSettings,
    engineInfo: routeEngineInfo,
    exportWorkspaceBusy: false,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });


  const remoteWorkspaceConnectionEditor = useRemoteWorkspaceConnectionEditor({
    workspaces,
    client,
    onSaved: handleRemoteWorkspaceConnectionSaved,
  });


  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set(retryingWorkspaceIds)),
    [errorsByWorkspaceId, retryingWorkspaceIds, sessionsByWorkspaceId, workspaces],
  );
  useSessionGroupSync({ workspaces, endpointForWorkspace });
  const selectedWorkspaceGroupState = sessionManagementStore((state) => (
    selectedWorkspaceId ? state.groupsByWorkspace[selectedWorkspaceId] : undefined
  ));
  const assignSessionToGroup = sessionManagementStore((state) => state.assignGroup);
  const seedWorkspaceActivitySessions = useSessionActivityStore((state) => state.seedWorkspaceSessions);
  const sessionActivityByWorkspaceId = useSessionActivityStore((state) => state.statusesByWorkspaceId);

  useEffect(() => {
    for (const group of workspaceSessionGroups) {
      seedWorkspaceActivitySessions(group.workspace.id, group.sessions);
      const serverId = workspaceServerId(group.workspace);
      if (serverId && serverId !== group.workspace.id) {
        seedWorkspaceActivitySessions(serverId, group.sessions);
      }
    }
  }, [seedWorkspaceActivitySessions, workspaceSessionGroups]);

  const sidebarSessionStatusById = useMemo(() => {
    const next: Record<string, string> = {};
    for (const group of workspaceSessionGroups) {
      const serverId = workspaceServerId(group.workspace);
      const workspaceStatuses = {
        ...(sessionActivityByWorkspaceId[group.workspace.id] ?? {}),
        ...(serverId ? sessionActivityByWorkspaceId[serverId] ?? {} : {}),
      };
      for (const session of group.sessions) {
        const status = workspaceStatuses[session.id];
        if (status) next[session.id] = status;
      }
    }
    return next;
  }, [sessionActivityByWorkspaceId, workspaceSessionGroups]);

  const sidebarActiveWorkspaceId = useMemo(() => {
    const sessionId = selectedSessionId?.trim() ?? "";
    if (sessionId) {
      const owner = workspaceSessionGroups.find((group) =>
        group.sessions.some((session) => session?.id === sessionId),
      );
      if (owner?.workspace.id) return owner.workspace.id;
    }
    return selectedWorkspaceId;
  }, [selectedSessionId, selectedWorkspaceId, workspaceSessionGroups]);

  const workspaceConnectionStateById = useMemo(() => {
    const next: Record<string, WorkspaceConnectionState> = { ...workspaceConnectionOverrides };
    for (const workspace of workspaces) {
      if (workspace.workspaceType !== "remote") continue;
      const error = errorsByWorkspaceId[workspace.id]?.trim();
      if (!error || next[workspace.id]?.status === "connecting") continue;
      next[workspace.id] ??= {
        status: "error",
        message: getWorkspaceTaskLoadErrorDisplay(workspace, error).message || error,
        checkedAt: null,
      };
    }
    return next;
  }, [errorsByWorkspaceId, workspaceConnectionOverrides, workspaces]);

  const mcpConnectedCount = useMcpConnectedCount(opencodeClient, selectedWorkspaceRoot);
  const providerListQuery = useProviderListQuery({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    directory: selectedWorkspaceRoot || undefined,
  });
  const { providerCatalog, modelVariantLabel, modelBehaviorOptions, modelVariantValue } =
    useModelBehavior({
      providerList: providerListQuery.data,
      defaultModel: local.prefs.defaultModel,
      modelVariant: local.prefs.modelVariant ?? null,
    });
  const {
    store: sessionProviderAuthStore,
    snapshot: sessionProviderAuthSnapshot,
    cloudProviderSyncReady,
    cloudProviderList,
    refreshCloudProviderSync,
  } = useSessionProviderAuth({
    opencodeClient,
    opencodeBaseUrl,
    providers,
    providerDefaults,
    providerConnectedIds,
    disabledProviderIds,
    selectedWorkspace,
    selectedWorkspaceEndpoint,
    selectedWorkspaceRoot,
    selectedWorkspaceId,
    localServerHostToken: openworkServerHostInfoState?.hostToken?.trim() ?? "",
    setProviders,
    setProviderDefaults,
    setProviderConnectedIds,
    setDisabledProviderIds,
  });
  const organizationAssignedModelOptions = useMemo(
    () => assignedModelOptions(sessionProviderAuthSnapshot.cloudOrgProviders),
    [sessionProviderAuthSnapshot.cloudOrgProviders],
  );
  useEffect(() => {
    if (!denAuth.isSignedIn) {
      setActiveOrganizationRole(null);
      return;
    }

    const settings = readDenSettings();
    const tokenValue = settings.authToken?.trim() ?? "";
    const activeOrgId = settings.activeOrgId?.trim() ?? "";
    const activeOrgSlug = settings.activeOrgSlug?.trim() ?? "";
    if (!tokenValue || (!activeOrgId && !activeOrgSlug)) {
      setActiveOrganizationRole(null);
      return;
    }

    let cancelled = false;
    void createDenClient({ baseUrl: settings.baseUrl, token: tokenValue })
      .listOrgs()
      .then((response) => {
        if (cancelled) return;
        const active = response.orgs.find((org) =>
          org.id === activeOrgId || org.slug === activeOrgSlug,
        );
        setActiveOrganizationRole(active?.role ?? null);
      })
      .catch(() => {
        if (!cancelled) setActiveOrganizationRole(null);
      });

    return () => {
      cancelled = true;
    };
  }, [denAuth.isSignedIn, denAuth.status, denSessionVersion]);
  const handleModelPickerOpen = useCallback(() => {
    void refreshCloudProviderSync("model_picker_open");
  }, [refreshCloudProviderSync]);
  const openWorkModelsEntitled = useMemo(() => {
    if (!denAuth.isSignedIn) return false;
    const fromOrg = sessionProviderAuthSnapshot.cloudOrgProviders.some(
      (provider) =>
        [provider.providerId, provider.source].some(
          (value) => value?.trim().toLowerCase() === "openwork",
        ),
    );
    const fromImport = Object.values(sessionProviderAuthSnapshot.importedCloudProviders ?? {}).some(
      (provider) =>
        [provider.providerId, provider.source, provider.sourceProviderId].some(
          (value) => value?.trim().toLowerCase() === "openwork",
        ),
    );
    return fromOrg || fromImport;
  }, [
    denAuth.isSignedIn,
    sessionProviderAuthSnapshot.cloudOrgProviders,
    sessionProviderAuthSnapshot.importedCloudProviders,
  ]);
  const refreshOrganizationModelAccess = useCallback(async () => {
    await refreshCloudProviderSync("manual");
  }, [refreshCloudProviderSync]);
  useEffect(() => {
    if (!cloudProviderSyncReady || !cloudProviderList) return;
    clearCloudMcpSubmissionFailure();
  }, [clearCloudMcpSubmissionFailure, cloudProviderList, cloudProviderSyncReady]);
  const organizationModelsSettingsUrl = useMemo(() => {
    if (!isDenOrgAdminRole(activeOrganizationRole)) {
      return undefined;
    }
    return new URL("/dashboard/custom-llm-providers", readDenSettings().baseUrl).toString();
  }, [activeOrganizationRole, denSessionVersion]);
  const restrictToCloudProviders = checkDesktopRestriction({ restriction: "allowCustomProviders" });
  const entitledModelOptions = useMemo(() => {
    const runtimeOptions = providerListModelEntitlementOptions(
      cloudProviderList ?? providerListQuery.data,
    );
    return filterEntitledModelOptions(
      runtimeOptions.length > 0 ? runtimeOptions : organizationAssignedModelOptions,
      {
        restrictToCloud: restrictToCloudProviders,
        checkRestriction: checkDesktopRestriction,
      },
    );
  }, [
    checkDesktopRestriction,
    cloudProviderList,
    organizationAssignedModelOptions,
    providerListQuery.data,
    restrictToCloudProviders,
  ]);
  const openWorkModelsAvailable = hasOpenWorkModelsAvailable({
    providerConnectedIds,
    providers,
  });
  const openWorkModelsSyncing = shouldShowOpenWorkModelsSyncing({
    entitled: openWorkModelsEntitled,
    available: openWorkModelsAvailable,
    workspaceReady: Boolean(selectedWorkspaceId && opencodeClient),
    reloadPending: sessionProviderAuthSnapshot.cloudProviderServerSync?.reloadPending === true,
  });
  const organizationModelsEmpty = isOrganizationModelsEmpty({
    workspaceReady: Boolean(selectedWorkspaceId && opencodeClient),
    loading,
    restrictToCloud: restrictToCloudProviders,
    cloudProviderSyncReady,
    entitledModelCount: entitledModelOptions.length,
  });
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
    onOpen: handleModelPickerOpen,
    fallbackOptions: organizationAssignedModelOptions,
    cloudProvidersEnabled: denAuth.isSignedIn,
  });
  // Which session the open model picker targets. Selecting a model while a
  // session is targeted remembers it for that conversation only; null means
  // the picker edits the global default (e.g. opened from the new-providers
  // toast). Composer "All models" carries the session id on the open event.
  const [modelPickerSessionId, setModelPickerSessionId] = useState<string | null>(null);
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
      setModelPickerSessionId(typeof detail?.sessionId === "string" ? detail.sessionId : null);
    };
    window.addEventListener(openModelPickerEvent, handler);
    return () => window.removeEventListener(openModelPickerEvent, handler);
  }, []);
  const entitledOrgDefaultModel = useMemo(() => {
    const runtimeOptions = providerListModelEntitlementOptions(
      cloudProviderList ?? providerListQuery.data,
    );
    return resolveEntitledOrgDefaultModel(
      runtimeOptions.length > 0 ? runtimeOptions : organizationAssignedModelOptions,
      {
        currentDefault: local.prefs.defaultModel,
        restrictToCloud: restrictToCloudProviders,
        checkRestriction: checkDesktopRestriction,
      },
    );
  }, [
    checkDesktopRestriction,
    cloudProviderList,
    local.prefs.defaultModel,
    organizationAssignedModelOptions,
    providerListQuery.data,
    restrictToCloudProviders,
  ]);
  useEffect(() => {
    if (entitledOrgDefaultModel) writeStoredDefaultModel(entitledOrgDefaultModel);
  }, [entitledOrgDefaultModel]);
  // Availability is resolved per effective model identity: the New Task
  // composer validates the global default while each conversation validates
  // its OWN remembered provider/model against the current workspace's
  // catalogs. The provider-list query is keyed by server + workspace
  // directory, so a workspace switch supersedes the old catalog (the new key
  // reads as unsettled → pending) instead of judging the new workspace with
  // stale data.
  //
  // Catalog denials are additionally confirmation-gated: Settings visits and
  // engine reload churn can settle a momentarily incomplete catalog, and a
  // denial younger than the confirmation window renders as pending instead of
  // flashing "Model no longer available" during the transition. The recheck
  // tick re-evaluates tracked denials so a genuine one still surfaces once it
  // matures, even without further catalog changes.
  const modelAvailabilityGate = useMemo(() => createUnavailableConfirmationGate(), []);
  const [availabilityRecheckTick, bumpAvailabilityRecheck] = useReducer(
    (value: number) => value + 1,
    0,
  );
  const resolveModelAvailability = useCallback((model: ModelRef | null): ModelAvailability =>
    modelAvailabilityGate.confirm(model, computeModelAvailability(model, {
      workspaceReady: Boolean(selectedWorkspaceId && opencodeClient),
      loading,
      signedIn: denAuth.isSignedIn,
      cloudProviderSyncReady,
      openWorkModelsSyncing,
      restrictToCloud: restrictToCloudProviders,
      checkRestriction: checkDesktopRestriction,
      cloudProviderList,
      providerList: providerListQuery.data,
    })), [
    // The tick only forces re-evaluation of denials tracked by the gate.
    availabilityRecheckTick,
    checkDesktopRestriction,
    cloudProviderList,
    cloudProviderSyncReady,
    denAuth.isSignedIn,
    loading,
    modelAvailabilityGate,
    opencodeClient,
    openWorkModelsSyncing,
    providerListQuery.data,
    restrictToCloudProviders,
    selectedWorkspaceId,
  ]);
  useEffect(() => {
    const delay = modelAvailabilityGate.nextRecheckDelay();
    if (delay === null) return;
    const timer = window.setTimeout(() => bumpAvailabilityRecheck(), delay + 16);
    return () => window.clearTimeout(timer);
  }, [modelAvailabilityGate, resolveModelAvailability]);
  const selectedModelUnavailable =
    resolveModelAvailability(local.prefs.defaultModel ?? null).status === "unavailable";
  // The composer the user is looking at: the selected conversation's
  // remembered model when it has one, otherwise the global default.
  const selectedSessionModelSelection = useSessionModelStore((state) =>
    (selectedSessionId ? state.bySessionId[selectedSessionId] ?? null : null),
  );
  const activeComposerModel = selectedSessionModelSelection?.model ?? local.prefs.defaultModel ?? null;
  const activeComposerAvailability = resolveModelAvailability(activeComposerModel);
  const activeComposerTargetsSession = Boolean(selectedSessionModelSelection && selectedSessionId);
  const selectedModelUnavailableKey = activeComposerAvailability.status === "unavailable" && activeComposerModel
    ? `${activeComposerTargetsSession ? selectedSessionId : "default"}:${activeComposerModel.providerID}:${activeComposerModel.modelID}`
    : null;
  const autoOpenedUnavailableModelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedModelUnavailableKey) {
      // The active composer's model is fine (or pending). If the picker was
      // auto-opened for a previously broken composer — e.g. the New Task
      // default — do not let that recovery modal follow the user into a
      // conversation whose own model is valid.
      if (autoOpenedUnavailableModelRef.current) {
        modelPicker.setOpen(false);
      }
      autoOpenedUnavailableModelRef.current = null;
      return;
    }
    if (!shouldAutoOpenUnavailableModelPicker({
      selectedModelUnavailableKey,
      signedIn: denAuth.isSignedIn,
      cloudProviderSyncReady,
      // Silent default repair only applies when the broken selection IS the
      // default; a conversation's own unavailable model must surface the
      // picker for that conversation instead.
      entitledOrgDefaultModel: activeComposerTargetsSession ? false : Boolean(entitledOrgDefaultModel),
      organizationModelsEmpty,
      autoOpenedUnavailableModelKey: autoOpenedUnavailableModelRef.current,
    })) return;
    if (!activeComposerTargetsSession && entitledOrgDefaultModel) {
      writeStoredDefaultModel(entitledOrgDefaultModel);
      return;
    }

    autoOpenedUnavailableModelRef.current = selectedModelUnavailableKey;
    setModelPickerSessionId(activeComposerTargetsSession ? selectedSessionId : null);
    modelPicker.setQuery("");
    modelPicker.setRecentProviderIds(new Set());
    modelPicker.setCompactOpen(false);
    modelPicker.setOpen(true);
  }, [activeComposerTargetsSession, cloudProviderSyncReady, denAuth.isSignedIn, entitledOrgDefaultModel, modelPicker.setCompactOpen, modelPicker.setOpen, modelPicker.setQuery, modelPicker.setRecentProviderIds, organizationModelsEmpty, selectedModelUnavailableKey, selectedSessionId]);

  // Optimistic model selection: a remembered model is treated as valid until
  // the availability gate CONFIRMS it absent (selectedModelUnavailable).
  // A merely-pending verdict (cloud sync settling, catalog reloading) never
  // blocks task creation or paints loading chrome — if the optimism turns out
  // wrong, the send-time re-check and the composer's model-unavailable pill
  // surface it where the person can act on it.
  const hasUsableModel = Boolean(
    local.prefs.defaultModel &&
      !selectedModelUnavailable,
  );
  const canCreateTask = Boolean(
    opencodeClient &&
      selectedWorkspaceId &&
      !loading &&
      !selectedWorkspaceError &&
      !selectedModelUnavailable,
  );

  const {
    activePermission,
    permissionReplyBusy,
    respondPermission,
    activeQuestion,
    questionReplyBusy,
    respondQuestion,
    todos,
  } = useSessionInteractions({
    client: opencodeClient,
    workspaceId: selectedWorkspaceId,
    sessionId: selectedSessionId,
    workspaceRoot: selectedWorkspaceRoot,
  });
  const modelUnavailableMessage = organizationModelsEmpty
    ? t("models.organization_models_empty")
    : selectedModelUnavailable
      ? t("models.model_unavailable_short")
      : null;
  useEffect(() => {
    if (!opencodeClient) {
      setProviders([]);
      setProviderDefaults({});
      setProviderConnectedIds([]);
      return;
    }

    let cancelled = false;

    const applyProviderState = (value: ProviderListResponse) => {
      if (cancelled) return;
      // When not signed in, filter out every cloud-managed provider key so
      // stale org imports and the hosted `openwork` catalog do not reappear.
      const hasCloudAuth = !!readDenSettings().authToken?.trim();
      const all = hasCloudAuth
        ? ((value.all ?? []) as ProviderListItem[])
        : ((value.all ?? []) as ProviderListItem[]).filter(
            (provider) => !isCloudManagedProviderKey(provider.id ?? ""),
          );
      const connected = hasCloudAuth
        ? (value.connected ?? [])
        : (value.connected ?? []).filter((id) => !isCloudManagedProviderKey(id));
      setProviders(all);
      setProviderConnectedIds(connected);
      // New-provider detection is handled globally by the provider auth
      // store's applyProviderListState, which fires dispatchNewProviders.
    };

    void (async () => {
      let disabledProviders: string[] = [];
      try {
        const config = unwrap(
          await opencodeClient.config.get({
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        disabledProviders = disabledProvidersFromConfig(config);
        if (!cancelled) setDisabledProviderIds(disabledProviders);
      } catch {
        // ignore config read failures and continue with provider discovery
      }

      try {
        applyProviderState(
          filterProviderList(
            await ensureProviderListQuery(getReactQueryClient(), {
              client: opencodeClient,
              baseUrl: opencodeBaseUrl,
              directory: selectedWorkspaceRoot || undefined,
            }),
            disabledProviders,
          ),
        );
      } catch {
        if (cancelled) return;
        setProviders([]);
        setProviderDefaults({});
        setProviderConnectedIds([]);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opencodeBaseUrl, opencodeClient, selectedWorkspaceRoot, denSessionVersion]);

  const modelLabel = local.prefs.defaultModel
    ? resolveModelDisplayName(local.prefs.defaultModel.modelID)
    : t("session.default_model");

  const listSlashCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    // engineReloadVersion is included so the callback identity changes after
    // an engine reload, which invalidates the composer's command list cache
    // and causes it to re-fetch (picking up newly created skills).
    void engineReloadVersion;
    if (!opencodeClient) return [];
    return listCommands(opencodeClient, selectedWorkspaceRoot || undefined);
  }, [engineReloadVersion, opencodeClient, selectedWorkspaceRoot]);

  // Shared by the composer (plug menu, @ mentions) and the command palette.
  // Hidden and subagent-only entries are excluded — those are task-tool
  // delegation targets, not agents the user can run a session as.
  const listAgents = useCallback(async () => {
    // Include engineReloadVersion so the composer refetches after newly added
    // agent files become available, even when the inline picker is hidden.
    void engineReloadVersion;
    if (!opencodeClient) return [];
    const list = unwrap(await opencodeClient.app.agents());
    return list.filter(isLibraryAgent);
  }, [engineReloadVersion, opencodeClient]);

  const handleOpenSettings = useCallback((route = "/settings/general", workspaceId = sidebarActiveWorkspaceId) => {
    const sessionId = workspaceId === sidebarActiveWorkspaceId ? selectedSessionId : null;
    const tab = route.replace(/^\/settings\/?/, "").replace(/^\/+|\/+$/g, "") || "general";
    const target = workspaceId ? workspaceSettingsRoute(workspaceId, tab) : route;
    writeActiveWorkspaceId(workspaceId || null);
    navigate(target, { state: { workspaceId, sessionId } });
  }, [navigate, selectedSessionId, sidebarActiveWorkspaceId]);

  const handleOpenExtensions = useCallback((path = "", workspaceId = sidebarActiveWorkspaceId) => {
    const sessionId = workspaceId === sidebarActiveWorkspaceId ? selectedSessionId : null;
    const extensionPath = path
      .replace(/^\/settings\/extensions\/?/, "")
      .replace(/^\/extensions\/?/, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/^mcp$/, "mcps");
    const target = workspaceId
      ? workspaceExtensionsRoute(workspaceId, extensionPath)
      : globalExtensionsRoute(extensionPath);
    writeActiveWorkspaceId(workspaceId || null);
    navigate(target, { state: { workspaceId, sessionId } });
  }, [navigate, selectedSessionId, sidebarActiveWorkspaceId]);

  const extensionsMainOpen = /^\/(?:workspace\/[^/]+\/)?extensions(?:\/|$)/.test(location.pathname);

  const surfaceProps = useMemo(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId || !opencodeBaseUrl || !token || !opencodeClient) {
      return null;
    }

    // Transient-safety: when the user switches workspaces the URL-driven
    // selectedSessionId may still point at a session from the old workspace
    // for one render tick. Only block rendering when we KNOW the session
    // belongs to a different workspace (i.e., it exists in another
    // workspace's list). A brand-new session that hasn't been refreshed
    // into any list yet must still render so "New task" feels instant.
    let sessionOwnedByOtherWorkspace = false;
    for (const [workspaceId, sessions] of Object.entries(sessionsByWorkspaceId)) {
      if (workspaceId === selectedWorkspaceId) continue;
      if ((sessions ?? []).some((session) => session?.id === selectedSessionId)) {
        sessionOwnedByOtherWorkspace = true;
        break;
      }
    }
    if (sessionOwnedByOtherWorkspace) {
      return null;
    }

    // Note: do NOT include `client`, `workspaceId`, `sessionId`,
    // `opencodeBaseUrl`, or `openworkToken` here. SessionPage forwards those
    // explicitly to SessionSurface from the per-workspace endpoint resolved
    // by `resolveWorkspaceEndpoint`. If we leak them in here, the spread of
    // `surfaceProps` in SessionPage overrides those correct values with the
    // local server's, and remote workspaces silently end up calling the
    // local server with the local `rem_*` id.
    return {
      workspaceRoot: selectedWorkspaceRoot,
      draftScope: sessionDraftScope,
      developerMode: false,
      modelLabel,
      onModelClick: (sessionId?: string) => {
        setModelPickerSessionId(sessionId ?? null);
        modelPicker.setQuery("");
        modelPicker.setOpen(true);
      },
      providerCatalog,
      modelPickerOpen: modelPicker.compactOpen,
      // Legacy fallback only; each surface resolves availability for its own
      // effective session model through `resolveModelAvailability`.
      modelUnavailable: selectedModelUnavailable,
      modelUnavailableMessage,
      resolveModelAvailability,
      organizationModelsEmpty,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      openWorkModelsEntitled,
      openWorkModelsSyncing,
      onRefreshOrganizationModels: refreshOrganizationModelAccess,
      onModelPickerOpenChange: (open: boolean) => {
        modelPicker.setCompactOpen(open);
        if (open) {
          void refreshCloudProviderSync("model_picker_open");
        }
      },
      onModelChange: (model: ModelRef, variant?: string | null) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: variant !== undefined
            ? variant
            : previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
              ? previous.modelVariant
              : null,
        }));
        modelPicker.setCompactOpen(false);
      },
      providerConnectedCount: hasUsableModel ? 1 : providerConnectedIds.length,
      onOpenSettingsSection: (section: ComposerSettingsSection) => {
        openComposerConfigure(section, {
          openLibrary: handleOpenExtensions,
          openSettings: handleOpenSettings,
        });
      },
      onSendDraft: async (draft: ComposerDraft, sessionId: string): Promise<CloudMcpSubmissionResult> => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return { outcome: "cancelled", reason: "context_changed" };
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!text && draft.attachments.length === 0) {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        // Per-conversation model memory: a session that picked its own model
        // sends with it (and its variant) instead of the global default.
        const sessionModelSelection = getSessionModelSelection(targetSessionId);
        const sendModel = sessionModelSelection?.model ?? local.prefs.defaultModel;
        const sendVariant = sessionModelSelection ? sessionModelSelection.variant : modelVariantValue;
        // Send-time validation targets the exact provider/model identity this
        // conversation displays and will submit — not the global default.
        if (resolveModelAvailability(sendModel ?? null).status === "unavailable") {
          throw new Error("Selected model is unavailable. Choose another model before sending.");
        }

        return submitWithCloudMcpReadiness({
          // Temporarily bypass the pre-send Cloud MCP gate: it blocks every
          // message, including tasks that do not use connected services.
          skipGate: true,
          send: async () => {
            await sendWithRevertRollback({
              revertMessageId: draft.revertMessageId,
              abort: () => abortSessionSafe(opencodeClient, targetSessionId, selectedWorkspaceRoot || undefined, {
                source: "session.edit_resend.before_revert",
                initiator: "user",
                reason: "abort active run before replacing a reverted message",
              }),
              revert: async (messageId) => {
                const reverted = await revertSession(opencodeClient, targetSessionId, messageId);
                applySessionRevert(selectedWorkspaceId, reverted);
              },
              prompt: async () => {
                captureAnalyticsEvent("task_message_sent", {
                  mode: draft.mode ?? "prompt",
                  is_command: Boolean(draft.command),
                  attachment_count: draft.attachments.length,
                  text_length: text.length,
                  workspace_type: selectedWorkspace?.workspaceType ?? "unknown",
                  provider_id: sendModel?.providerID ?? null,
                  model_id: sendModel?.modelID ?? null,
                });
                markTaskRunStart(targetSessionId);
                // Den org adoption signals (auth-gated inside; no-op when signed out).
                // This remains inside the post-readiness send closure so a blocked
                // Cloud submission cannot create a run or report that one started.
                const projectDimension = readWorkspaceProjectDimension(selectedWorkspaceId);
                const modelSelection = sessionModelSelection ? "manual" : "default";
                const telemetryDimensions = [
                  ...(projectDimension ? [{
                    type: "project",
                    label: projectDimension.label,
                  }] : []),
                  ...(sendModel ? [{
                    type: "model",
                    value: `${sendModel.providerID}/${sendModel.modelID}`,
                    label: `${sendModel.providerID}/${sendModel.modelID}`,
                  }] : []),
                  {
                    type: "model_selection",
                    value: modelSelection,
                    label: modelSelection,
                  },
                ];
                trackSessionActive(targetSessionId, telemetryDimensions);
                trackTaskStarted(targetSessionId, telemetryDimensions);

                if (draft.mode === "shell") {
                  await shellInSession(opencodeClient, targetSessionId, text);
                  return;
                }

                if (draft.command) {
                  const result = await opencodeClient.session.command({
                    sessionID: targetSessionId,
                    command: draft.command.name,
                    arguments: draft.command.arguments,
                  });
                  if (result.error) {
                    throw new Error(serializeSDKError(result.error));
                  }
                  return;
                }

                const parts = await draftToParts(draft, selectedWorkspaceRoot, targetSessionId, selectedWorkspaceEndpoint);
                const envSystemContext = await buildOpenworkEnvSystemContext(client, {
                  cacheKey: targetSessionId,
                  runtimeKey: environmentRuntimeKey,
                });
                const result = await opencodeClient.session.promptAsync({
                  sessionID: targetSessionId,
                  parts,
                  model: sendModel ?? undefined,
                  agent: selectedAgent ?? undefined,
                  ...(sendVariant ? { variant: sendVariant } : {}),
                  ...(envSystemContext ? { system: envSystemContext } : {}),
                });
                if (result.error) {
                  throw new Error(serializeSDKError(result.error));
                }
                // Remember what this conversation used last so returning to it
                // (or splitting it beside another session) keeps its own model.
                if (sendModel) {
                  useSessionModelStore.getState().setModel(targetSessionId, sendModel, sendVariant ?? null);
                }
              },
              unrevert: async () => {
                try {
                  await unrevertSession(opencodeClient, targetSessionId);
                } finally {
                  applySessionUnrevert(selectedWorkspaceId, targetSessionId);
                }
              },
              onUnrevertError: (error) => console.warn("[edit-resend] rollback failed", error),
            });
          },
        });
      },
      cloudMcpSubmissionState,
      onOpenConnect: () => handleOpenExtensions(),
      onDraftChange: () => {
        // Draft persistence will be wired once the full React shell owns session state.
      },
      attachmentsEnabled: true,
      attachmentsDisabledReason: null,
      modelVariantLabel,
      modelVariant: modelVariantValue,
      modelBehaviorOptions,
      onModelVariantChange: (value: string | null) => {
        local.setPrefs((previous) => ({ ...previous, modelVariant: value }));
      },
      agentLabel: selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent"),
      selectedAgent,
      listAgents,
      onSelectAgent: (agent: string | null) => setSelectedAgent(agent),
      listCommands: listSlashCommands,
      recentFiles: [],
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        const result = unwrap(
          await opencodeClient.find.files({
            query: trimmed,
            dirs: "true",
            limit: 50,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        return result;
      },
      isRemoteWorkspace: selectedWorkspace?.workspaceType === "remote",
      isSandboxWorkspace: selectedWorkspace ? isSandboxWorkspace(selectedWorkspace) : false,
      onRevertToMessage: async (messageId: string, sessionId: string) => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return false;
        try {
          // Abort any running generation first; OpenCode rejects revert on busy sessions.
          await abortSessionSafe(opencodeClient, targetSessionId, selectedWorkspaceRoot || undefined, {
            source: "session.revert_to_message.before_revert",
            initiator: "user",
            reason: "abort active run before reverting transcript",
          });
          const reverted = await revertSession(opencodeClient, targetSessionId, messageId);
          // Stamp the revert cursor into the local caches so the transcript
          // rewinds immediately instead of waiting for a full reload.
          applySessionRevert(selectedWorkspaceId, reverted);
          return true;
        } catch (error) {
          console.warn("[revert] failed", error);
          toast.error(t("session.revert_failed"));
          return false;
        }
      },
      onRestoreRevertedSession: async (sessionId: string) => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return false;
        try {
          await unrevertSession(opencodeClient, targetSessionId);
          applySessionUnrevert(selectedWorkspaceId, targetSessionId);
          return true;
        } catch (error) {
          console.warn("[unrevert] failed", error);
          toast.error(t("session.restore_failed"));
          return false;
        }
      },
      onForkAtMessage: (messageId: string | null, sessionId: string) => {
        void (async () => {
          const targetSessionId = sessionId.trim() || selectedSessionId;
          if (!targetSessionId) return;
          try {
            const forked = await forkSession(opencodeClient, targetSessionId, messageId ?? undefined);
            writeLastSessionFor(selectedWorkspaceId, forked.id);
            rememberPendingCreatedSession(selectedWorkspaceId, forked.id);
            setSessionsByWorkspaceId((current) => ({
              ...current,
              [selectedWorkspaceId]: [forked, ...(current[selectedWorkspaceId] ?? [])],
            }));
            navigateToWorkspaceSession(selectedWorkspaceId, forked.id);
            void refreshRouteState();
          } catch (error) {
            console.warn("[fork] failed", error);
            toast.error(t("session.branch_failed"));
          }
        })();
      },
      onChangeModel: (model: { providerID: string; modelID: string }) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
      },
      environmentRuntimeKey,
      onApplyEnvironmentChanges: isDesktopRuntime() && selectedWorkspace?.workspaceType !== "remote"
        ? handleApplyEnvironmentChanges
        : undefined,
    };
  }, [
    client,
    modelPicker.compactOpen,
    handleOpenExtensions,
    handleOpenSettings,
    hasUsableModel,
    handleApplyEnvironmentChanges,
    environmentRuntimeKey,
    local,
    listAgents,
    listSlashCommands,
    modelBehaviorOptions,
    cloudMcpSubmissionState,
    modelLabel,
    modelUnavailableMessage,
    organizationModelsEmpty,
    modelVariantLabel,
    modelVariantValue,
    navigate,
    providerCatalog,
    openWorkModelsEntitled,
    openWorkModelsSyncing,
    refreshCloudProviderSync,
    refreshOrganizationModelAccess,
    resolveModelAvailability,
    opencodeBaseUrl,
    opencodeClient,
    providerConnectedIds,
    selectedAgent,
    selectedSessionId,
    sessionDraftScope,
    selectedModelUnavailable,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    submitWithCloudMcpReadiness,
    token,
  ]);
  const resolvePaneRuntime = useCallback((session: OpenSessionTab): SessionPagePaneRuntime => {
    const candidateWorkspace = workspaces.find((candidate) => candidate.id === session.workspaceId);
    const workspaceTitle = session.workspaceTitle?.trim()
      || (candidateWorkspace ? workspaceLabel(candidateWorkspace) : session.workspaceId);
    const connection = candidateWorkspace ? workspaceConnectionStateById[candidateWorkspace.id] : undefined;
    const workspaceError = candidateWorkspace ? errorsByWorkspaceId[candidateWorkspace.id]?.trim() : undefined;
    const paneEndpoint = resolveWorkbenchPaneEndpoint({
      workspaceId: session.workspaceId,
      workspaceTitle,
      workspace: candidateWorkspace,
      endpoint: endpointForWorkspace(candidateWorkspace),
      connectionError: connection?.status === "error" ? connection.message : workspaceError,
    });
    if (paneEndpoint.status === "unavailable") return paneEndpoint;
    const { endpoint, workspace } = paneEndpoint;

    if (paneEndpoint.workspaceId === selectedWorkspaceId && surfaceProps) {
      return {
        status: "ready",
        workspaceId: paneEndpoint.workspaceId,
        workspaceTitle: paneEndpoint.workspaceTitle,
        workspaceRoot: selectedWorkspaceRoot,
        workspaceType: paneEndpoint.workspaceType,
        runtimeWorkspaceId: endpoint.workspaceId,
        opencodeBaseUrl: endpoint.opencodeBaseUrl,
        openworkToken: endpoint.token,
        client: endpoint.client,
        environmentClient: client,
        surface: surfaceProps,
      };
    }

    if (!surfaceProps) {
      return {
        status: "unavailable",
        workspaceId: paneEndpoint.workspaceId,
        workspaceTitle: paneEndpoint.workspaceTitle,
        message: "The session runtime is still preparing.",
      };
    }

    const workspaceRoot = paneEndpoint.workspaceRoot;
    const workspaceOpencodeClient = createClient(
      endpoint.opencodeBaseUrl,
      workspaceRoot || undefined,
      { token: endpoint.token, mode: "openwork" },
    );
    const scopedSurface = {
      ...surfaceProps,
      workspaceRoot,
      modelUnavailable: false,
      modelUnavailableMessage: null,
      resolveModelAvailability: undefined,
      cloudMcpSubmissionState: IDLE_CLOUD_MCP_SUBMISSION_GATE_STATE,
      onOpenSettingsSection: (section: ComposerSettingsSection) => {
        openComposerConfigure(section, {
          openLibrary: (path) => handleOpenExtensions(path, workspace.id),
          openSettings: (path) => handleOpenSettings(path, workspace.id),
        });
      },
      onOpenConnect: () => handleOpenExtensions("", workspace.id),
      listCommands: async (): Promise<SlashCommandOption[]> => {
        void engineReloadVersion;
        return listCommands(workspaceOpencodeClient, workspaceRoot || undefined);
      },
      listAgents: async () => {
        void engineReloadVersion;
        return unwrap(await workspaceOpencodeClient.app.agents()).filter(isLibraryAgent);
      },
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed) return [];
        return unwrap(await workspaceOpencodeClient.find.files({
          query: trimmed,
          dirs: "true",
          limit: 50,
          directory: workspaceRoot || undefined,
        }));
      },
      isRemoteWorkspace: workspace.workspaceType === "remote",
      isSandboxWorkspace: isSandboxWorkspace(workspace),
      environmentRuntimeKey: workspace.workspaceType === "remote" ? null : environmentRuntimeKey,
      onApplyEnvironmentChanges: undefined,
      onSendDraft: async (draft: ComposerDraft, sessionId: string): Promise<CloudMcpSubmissionResult> => {
        const targetSessionId = sessionId.trim() || session.sessionId;
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!targetSessionId || (!text && draft.attachments.length === 0)) {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        const sessionModelSelection = getSessionModelSelection(targetSessionId);
        const sendModel = sessionModelSelection?.model ?? local.prefs.defaultModel;
        const sendVariant = sessionModelSelection ? sessionModelSelection.variant : modelVariantValue;
        return submitWithCloudMcpReadiness({
          skipGate: true,
          send: async () => {
            await sendWithRevertRollback({
              revertMessageId: draft.revertMessageId,
              abort: () => abortSessionSafe(workspaceOpencodeClient, targetSessionId, workspaceRoot || undefined, {
                source: "session.edit_resend.before_revert",
                initiator: "user",
                reason: "abort active run before replacing a reverted message",
              }),
              revert: async (messageId) => {
                const reverted = await revertSession(workspaceOpencodeClient, targetSessionId, messageId);
                applySessionRevert(endpoint.workspaceId, reverted);
              },
              prompt: async () => {
                captureAnalyticsEvent("task_message_sent", {
                  mode: draft.mode ?? "prompt",
                  is_command: Boolean(draft.command),
                  attachment_count: draft.attachments.length,
                  text_length: text.length,
                  workspace_type: workspace.workspaceType ?? "unknown",
                  provider_id: sendModel?.providerID ?? null,
                  model_id: sendModel?.modelID ?? null,
                });
                markTaskRunStart(targetSessionId);
                const projectDimension = readWorkspaceProjectDimension(workspace.id);
                const modelSelection = sessionModelSelection ? "manual" : "default";
                const telemetryDimensions = [
                  ...(projectDimension ? [{ type: "project", label: projectDimension.label }] : []),
                  ...(sendModel ? [{
                    type: "model",
                    value: `${sendModel.providerID}/${sendModel.modelID}`,
                    label: `${sendModel.providerID}/${sendModel.modelID}`,
                  }] : []),
                  { type: "model_selection", value: modelSelection, label: modelSelection },
                ];
                trackSessionActive(targetSessionId, telemetryDimensions);
                trackTaskStarted(targetSessionId, telemetryDimensions);
                if (draft.mode === "shell") {
                  await shellInSession(workspaceOpencodeClient, targetSessionId, text);
                  return;
                }
                if (draft.command) {
                  const result = await workspaceOpencodeClient.session.command({
                    sessionID: targetSessionId,
                    command: draft.command.name,
                    arguments: draft.command.arguments,
                  });
                  if (result.error) throw new Error(serializeSDKError(result.error));
                  return;
                }
                const parts = await draftToParts(draft, workspaceRoot, targetSessionId, endpoint);
                const envSystemContext = await buildOpenworkEnvSystemContext(endpoint.client, {
                  cacheKey: targetSessionId,
                  runtimeKey: workspace.workspaceType === "remote" ? null : environmentRuntimeKey,
                });
                const result = await workspaceOpencodeClient.session.promptAsync({
                  sessionID: targetSessionId,
                  parts,
                  model: sendModel ?? undefined,
                  agent: selectedAgent ?? undefined,
                  ...(sendVariant ? { variant: sendVariant } : {}),
                  ...(envSystemContext ? { system: envSystemContext } : {}),
                });
                if (result.error) throw new Error(serializeSDKError(result.error));
                if (sendModel) {
                  useSessionModelStore.getState().setModel(targetSessionId, sendModel, sendVariant ?? null);
                }
              },
              unrevert: async () => {
                try {
                  await unrevertSession(workspaceOpencodeClient, targetSessionId);
                } finally {
                  applySessionUnrevert(endpoint.workspaceId, targetSessionId);
                }
              },
              onUnrevertError: (error) => console.warn("[edit-resend] rollback failed", error),
            });
          },
        });
      },
      onRevertToMessage: async (messageId: string, sessionId: string) => {
        const targetSessionId = sessionId.trim() || session.sessionId;
        try {
          await abortSessionSafe(workspaceOpencodeClient, targetSessionId, workspaceRoot || undefined, {
            source: "session.revert_to_message.before_revert",
            initiator: "user",
            reason: "abort active run before reverting transcript",
          });
          const reverted = await revertSession(workspaceOpencodeClient, targetSessionId, messageId);
          applySessionRevert(endpoint.workspaceId, reverted);
          return true;
        } catch (error) {
          console.warn("[revert] failed", error);
          toast.error(t("session.revert_failed"));
          return false;
        }
      },
      onRestoreRevertedSession: async (sessionId: string) => {
        const targetSessionId = sessionId.trim() || session.sessionId;
        try {
          await unrevertSession(workspaceOpencodeClient, targetSessionId);
          applySessionUnrevert(endpoint.workspaceId, targetSessionId);
          return true;
        } catch (error) {
          console.warn("[unrevert] failed", error);
          toast.error(t("session.restore_failed"));
          return false;
        }
      },
      onForkAtMessage: (messageId: string | null, sessionId: string) => {
        void (async () => {
          const targetSessionId = sessionId.trim() || session.sessionId;
          try {
            const forked = await forkSession(workspaceOpencodeClient, targetSessionId, messageId ?? undefined);
            writeLastSessionFor(workspace.id, forked.id);
            rememberPendingCreatedSession(workspace.id, forked.id);
            setSessionsByWorkspaceId((current) => ({
              ...current,
              [workspace.id]: [forked, ...(current[workspace.id] ?? [])],
            }));
            navigateToWorkspaceSession(workspace.id, forked.id);
            void refreshRouteState();
          } catch (error) {
            console.warn("[fork] failed", error);
            toast.error(t("session.branch_failed"));
          }
        })();
      },
    };
    return {
      status: "ready",
      workspaceId: paneEndpoint.workspaceId,
      workspaceTitle: paneEndpoint.workspaceTitle,
      workspaceRoot,
      workspaceType: paneEndpoint.workspaceType,
      runtimeWorkspaceId: endpoint.workspaceId,
      opencodeBaseUrl: endpoint.opencodeBaseUrl,
      openworkToken: endpoint.token,
      client: endpoint.client,
      environmentClient: client,
      surface: scopedSurface,
    };
  }, [
    client,
    endpointForWorkspace,
    engineReloadVersion,
    environmentRuntimeKey,
    errorsByWorkspaceId,
    handleOpenExtensions,
    handleOpenSettings,
    local.prefs.defaultModel,
    modelVariantValue,
    navigateToWorkspaceSession,
    refreshRouteState,
    rememberPendingCreatedSession,
    selectedAgent,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    setSessionsByWorkspaceId,
    submitWithCloudMcpReadiness,
    surfaceProps,
    workspaceConnectionStateById,
    workspaces,
  ]);
  const cloudWorkspaceMainContentDecision = mapCloudWorkspaceMainContentDecision({
    status: cloudWorkspace.viewModel.variant,
    hasWorkspaces: Boolean(surfaceProps),
    gatewayMode: cloudWorkspace.gatewayMode && cloudWorkspace.visible,
  });
  const cloudWorkspaceReadyForRouteErrors =
    !cloudWorkspace.gatewayMode ||
    !cloudWorkspace.visible ||
    cloudWorkspaceStatusHasReadyContent(cloudWorkspace.viewModel.variant);
  const cloudWorkspaceMainContentTakeover = cloudWorkspaceMainContentDecision === "takeover" ? (
    <CloudWorkspaceBootTakeover decision={cloudWorkspaceMainContentDecision} />
  ) : null;
  const gatedRouteNotFoundMessage = cloudWorkspaceReadyForRouteErrors ? routeNotFoundMessage : null;

  // Workspace-scoped wiring for the empty-state hero's full composer. Unlike
  // `surfaceProps` this exists without a selected session, so the hero offers
  // the same skills/commands/agent/model controls before the session is
  // created. Model and agent choices land in the same route-level state the
  // session composer reads, so they carry into the created session.
  const newTaskComposerContext = useMemo<NewTaskComposerContext | null>(() => {
    return {
      client,
      workspaceId: selectedWorkspaceId || null,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      modelOptions: organizationAssignedModelOptions,
      modelUnavailable: selectedModelUnavailable,
      modelUnavailableMessage,
      organizationModelsEmpty,
      onRefreshOrganizationModels: refreshOrganizationModelAccess,
      modelPickerOpen: modelPicker.compactOpen,
      onModelPickerOpenChange: (open: boolean) => {
        modelPicker.setCompactOpen(open);
        if (open) {
          void sessionProviderAuthStore.refreshCloudOrgProviders({ force: true }).catch(() => undefined);
          void refreshCloudProviderSync("model_picker_open");
        }
      },
      onModelChange: (model: ModelRef, variant?: string | null) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: variant !== undefined
            ? variant
            : previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
              ? previous.modelVariant
              : null,
        }));
        modelPicker.setCompactOpen(false);
      },
      openWorkModelsEntitled,
      openWorkModelsSyncing,
      modelVariantLabel,
      modelVariant: modelVariantValue,
      modelBehaviorOptions,
      onModelVariantChange: (value: string | null) => {
        local.setPrefs((previous) => ({ ...previous, modelVariant: value }));
      },
      agentLabel: selectedAgent ? selectedAgent.charAt(0).toUpperCase() + selectedAgent.slice(1) : t("session.default_agent"),
      selectedAgent,
      listAgents,
      onSelectAgent: (agent: string | null) => setSelectedAgent(agent),
      listCommands: listSlashCommands,
      searchFiles: async (query: string) => {
        const trimmed = query.trim();
        if (!trimmed || !opencodeClient) return [];
        const result = unwrap(
          await opencodeClient.find.files({
            query: trimmed,
            dirs: "true",
            limit: 50,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        return result;
      },
      isRemoteWorkspace: selectedWorkspace?.workspaceType === "remote",
      isSandboxWorkspace: selectedWorkspace ? isSandboxWorkspace(selectedWorkspace) : false,
      onOpenSettingsSection: (section: ComposerSettingsSection) => {
        openComposerConfigure(section, {
          openLibrary: handleOpenExtensions,
          openSettings: handleOpenSettings,
        });
      },
    };
  }, [
    client,
    handleOpenExtensions,
    handleOpenSettings,
    listAgents,
    listSlashCommands,
    local,
    modelUnavailableMessage,
    modelBehaviorOptions,
    modelPicker,
    modelVariantLabel,
    modelVariantValue,
    opencodeClient,
    openWorkModelsEntitled,
    openWorkModelsSyncing,
    organizationAssignedModelOptions,
    organizationModelsEmpty,
    refreshCloudProviderSync,
    refreshOrganizationModelAccess,
    selectedAgent,
    selectedModelUnavailable,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionProviderAuthStore,
    setSelectedAgent,
  ]);

  const handleOpenCreateWorkspace = useCallback(() => {
    if (!canCreateWorkspaces()) return;
    // Respect the org-level `allowMultipleWorkspaces` restriction (dev
    // #1505). If the checker returns true, the admin has disabled
    // adding further workspaces; surface a friendly notice instead of
    // opening the modal.
    if (
      workspaces.length > 0 &&
      checkDesktopRestriction({ restriction: "allowMultipleWorkspaces" })
    ) {
      restrictionNotice.show({
        title: "Additional workspaces are restricted",
        message:
          "Your organization administrator has restricted access to adding additional workspaces.",
      });
      return;
    }
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  }, [checkDesktopRestriction, restrictionNotice, workspaces.length]);

  const handleOpenRenameWorkspace = useCallback((workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace) return;
    setRenameWorkspaceId(workspaceId);
    setRenameWorkspaceTitle(
      workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        "",
    );
  }, [workspaces]);

  const handleSaveRenameWorkspace = useCallback(async () => {
    if (!renameWorkspaceId) return;
    const trimmed = renameWorkspaceTitle.trim();
    if (!trimmed) return;
    setRenameWorkspaceBusy(true);
    try {
      if (!client) {
        toast.error("OpenWork server is unavailable. Reconnect the server before renaming workspaces.");
        return;
      }
      await client.updateWorkspaceDisplayName(renameWorkspaceId, trimmed);
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
    } catch (error) {
      toast.error("Workspace rename failed", {
        description: describeRouteError(error),
      });
    } finally {
      setRenameWorkspaceBusy(false);
    }
  }, [client, refreshRouteState, renameWorkspaceId, renameWorkspaceTitle]);

  const handleRevealWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    const path = workspace?.path?.trim();
    if (!path || !isDesktopRuntime()) return;
    try {
      await revealDesktopItemInDir(path);
    } catch {
      // ignore
    }
  }, [workspaces]);

  const handleShareWorkspace = useCallback((workspaceId: string) => {
    shareWorkspaceState.openShareWorkspace(workspaceId);
  }, [shareWorkspaceState]);

  const handleSaveShareRemoteAccess = useCallback(
    async (enabled: boolean) => {
      if (!isDesktopRuntime()) return;
      await remoteAccessRestart.save(enabled);
    },
    [remoteAccessRestart],
  );

  const handleExportWorkspaceConfig = useCallback(
    async (workspaceId: string) => {
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
      if (!workspace) return;
      const endpoint = endpointForWorkspace(workspace);
      if (endpoint) {
        const payload = await endpoint.client.exportWorkspace(endpoint.workspaceId);
        downloadWorkspaceJson(workspaceExportFilename(workspace), payload);
        return;
      }
      throw new Error("OpenWork server is unavailable. Reconnect the server before exporting workspace config.");
    },
    [endpointForWorkspace, workspaces],
  );

  const handleForgetWorkspace = useCallback(
    async (workspaceId: string) => {
      if (typeof window !== "undefined") {
        const message =
          t("workspace_list.remove_confirm") ||
          "Remove this workspace from the sidebar?";
        if (!window.confirm(message)) return;
      }
      // Remove from both stores so the next refresh can't resurrect the row
      // from whichever list wins the merge.
      if (client) {
        await client.deleteWorkspace(workspaceId).catch(() => undefined);
      }
      if (isDesktopRuntime()) {
        await workspaceForget(workspaceId).catch(() => undefined);
      }
      if (selectedWorkspaceId === workspaceId) {
        setLegacySelectedWorkspaceId("");
        writeActiveWorkspaceId(null);
        navigate(legacySessionRoute());
      }
      forgetWorkspaceMemory(workspaceId);
      sessionManagementStore.getState().forgetWorkspace(workspaceId);
      await refreshRouteState();
    },
    [client, navigate, refreshRouteState, selectedWorkspaceId],
  );


  const applyLastUsedModelToSession = useCallback((sessionId: string) => {
    const previous = selectedSessionId ? getSessionModelSelection(selectedSessionId) : null;
    const model = previous?.model ?? local.prefs.defaultModel;
    if (!model?.providerID || !model.modelID) return;
    const variant = previous ? previous.variant : (local.prefs.modelVariant ?? null);
    useSessionModelStore.getState().setModel(sessionId, model, variant);
    local.setPrefs((current) => {
      if (
        current.defaultModel?.providerID === model.providerID
        && current.defaultModel.modelID === model.modelID
        && (current.modelVariant ?? null) === variant
      ) {
        return current;
      }
      return { ...current, defaultModel: model, modelVariant: variant };
    });
  }, [local, selectedSessionId]);

  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string): Promise<string | null> => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      !workspace ||
      loading ||
      retryingWorkspaceIds.includes(workspaceId)
    ) {
      return null;
    }
    const endpoint = endpointForWorkspace(workspace);
    if (!endpoint || !endpoint.token) {
      return null;
    }
    const workspaceClient = createClient(
      endpoint.opencodeBaseUrl,
      workspace.path?.trim() || undefined,
      { token: endpoint.token, mode: "openwork" },
    );
    try {
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRouteError(null);
      const session = unwrap(
        await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
      );
      if (workspaceId === selectedWorkspaceId) {
        void refreshCloudProviderSync("new_chat");
      }
      captureAnalyticsEvent("task_created", {
        source: "new_task",
        workspace_type: workspace.workspaceType ?? "unknown",
      });
      toast.dismiss(taskCreateUnavailableToastId(workspaceId));
      toast.dismiss();
      setLegacySelectedWorkspaceId(workspaceId);
      writeActiveWorkspaceId(workspaceId || null);
      writeLastSessionFor(workspaceId, session.id);
      rememberPendingCreatedSession(workspaceId, session.id);
      applyLastUsedModelToSession(session.id);
      setSessionsByWorkspaceId((current) => {
        const next = {
          ...current,
          [workspaceId]: [session, ...(current[workspaceId] ?? [])],
        };
        sessionsByWorkspaceIdRef.current = next;
        return next;
      });
      navigateToWorkspaceSession(workspaceId, session.id);
      focusPromptSoon();
      void refreshRouteState();
      return session.id;
    } catch (error) {
      const message = describeTaskCreateError(error);
      setRouteError(message);
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: message }));
      toast.error("OpenCode unavailable", {
        id: taskCreateUnavailableToastId(workspaceId),
        description: message,
        action: {
          label: "Retry",
          onClick: () => void handleCreateTaskInWorkspace(workspaceId),
        },
        duration: Infinity,
      });
      if (isTransientStartupError(message)) {
        setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
        if (startupRetryTimerRef.current === null) {
          startupRetryTimerRef.current = window.setTimeout(() => {
            startupRetryTimerRef.current = null;
            void refreshRouteState({ supersede: true });
          }, 1_000);
        }
      }
      return null;
    }
  }, [applyLastUsedModelToSession, endpointForWorkspace, loading, navigateToWorkspaceSession, refreshCloudProviderSync, refreshRouteState, rememberPendingCreatedSession, retryingWorkspaceIds, selectedWorkspaceId, workspaces]);

  // Latest session-list state for prev/next session tab navigation. The
  // `options` field is updated by `onSessionTabsChange` from SessionPage so we
  // only cycle through tabs the user actually opened (not artifact sessions).
  // The remaining fields are refreshed during render.
  const sessionTabNavRef = useRef<{
    options: OpenSessionTab[];
    workspaceId: string;
    sessionId: string | null;
    navigate: (workspaceId: string, sessionId?: string | null) => void;
  }>({ options: [], workspaceId: "", sessionId: null, navigate: () => {} });

  const goToSessionTabByOffset = useCallback((offset: number) => {
    const { options, workspaceId, sessionId, navigate } = sessionTabNavRef.current;
    const scoped = options.filter((option) => option.workspaceId === workspaceId);
    if (scoped.length === 0) return;
    const currentIndex = sessionId
      ? scoped.findIndex((option) => option.sessionId === sessionId)
      : -1;
    const nextIndex = currentIndex === -1
      ? offset > 0 ? 0 : scoped.length - 1
      : (currentIndex + offset + scoped.length) % scoped.length;
    const target = scoped[nextIndex];
    if (!target || target.sessionId === sessionId) return;
    navigate(target.workspaceId, target.sessionId);
  }, []);

  const goToNextSessionTab = useCallback(() => goToSessionTabByOffset(1), [goToSessionTabByOffset]);
  const goToPrevSessionTab = useCallback(() => goToSessionTabByOffset(-1), [goToSessionTabByOffset]);

  const cycleThinkingMode = useCallback((direction: ThinkingModeShortcutDirection = "forward") => {
    const workbench = useWorkbenchStore.getState();
    const activeSessionId = workbench.focusedPane === "secondary" && workbench.secondary
      ? workbench.secondary.sessionId
      : selectedSessionId;
    const selection = activeSessionId ? getSessionModelSelection(activeSessionId) : null;
    const summary = selection
      ? (() => {
          const model = providerCatalog?.[selection.model.providerID]?.[selection.model.modelID];
          return model
            ? getModelBehaviorSummary(selection.model.providerID, model, selection.variant)
            : null;
        })()
      : null;
    const options = selection ? (summary?.options ?? []) : modelBehaviorOptions;
    const current = selection ? (summary?.value ?? selection.variant) : modelVariantValue;
    const next = direction === "reverse"
      ? previousModelBehaviorValue(options, current)
      : nextModelBehaviorValue(options, current);
    if (!next) return null;

    if (activeSessionId && selection) {
      useSessionModelStore.getState().setVariant(activeSessionId, next);
    }
    // Match the composer's existing variant change path: session overrides are
    // remembered per conversation and the global fallback follows the choice.
    local.setPrefs((previous) => ({ ...previous, modelVariant: next }));
    return options.find((option) => option.value === next)?.label ?? next;
  }, [local, modelBehaviorOptions, modelVariantValue, providerCatalog, selectedSessionId]);

  const cycleThinkingModeControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.model_variant.cycle",
    label: "Cycle thinking mode",
    description: "Advance the focused conversation to its next available thinking or reasoning effort.",
    sideEffect: "mutation",
    execute: () => {
      const label = cycleThinkingMode();
      return label ? { ok: true, label } : { ok: false, error: "The focused model has fewer than two thinking modes." };
    },
  }), [cycleThinkingMode]);
  useControlAction(cycleThinkingModeControlAction);

  const cycleFavoriteModel = useCallback(() => {
    const workbench = useWorkbenchStore.getState();
    const activeSessionId = workbench.focusedPane === "secondary" && workbench.secondary
      ? workbench.secondary.sessionId
      : selectedSessionId;
    const selection = activeSessionId ? getSessionModelSelection(activeSessionId) : null;
    const currentModel = selection?.model ?? local.prefs.defaultModel ?? null;
    const next = nextFavoriteModel(useModelCollectionsStore.getState().favorites, currentModel);
    if (!next) return null;

    const providerModel = providerCatalog?.[next.providerID]?.[next.modelID];
    const summary = providerModel
      ? getModelBehaviorSummary(next.providerID, providerModel, selection?.variant ?? modelVariantValue)
      : null;
    const variant = summary && summary.options.length > 0 ? summary.value : null;
    if (activeSessionId) {
      useSessionModelStore.getState().setModel(activeSessionId, next, variant);
    }
    useModelCollectionsStore.getState().recordRecent(next);
    local.setPrefs((previous) => ({ ...previous, defaultModel: next, modelVariant: variant }));
    return providerModel?.name ?? next.modelID;
  }, [local, modelVariantValue, providerCatalog, selectedSessionId]);

  const cycleFavoriteModelControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "session.favorite_model.cycle",
    label: "Cycle favorite model",
    description: "Switch the focused conversation to its next favorite model.",
    sideEffect: "mutation",
    execute: () => {
      const label = cycleFavoriteModel();
      return label ? { ok: true, label } : { ok: false, error: "Add a favorite model before cycling favorites." };
    },
  }), [cycleFavoriteModel]);
  useControlAction(cycleFavoriteModelControlAction);

  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
    sessionNumberShortcuts,
  } = useShellShortcuts({
    canCreateTask,
    workspaceId: selectedWorkspaceId,
    onCreateTask: (workspaceId: string) => void handleCreateTaskInWorkspace(workspaceId),
    onNextSessionTab: goToNextSessionTab,
    onPrevSessionTab: goToPrevSessionTab,
    onCycleThinkingMode: cycleThinkingMode,
    onCycleFavoriteModel: cycleFavoriteModel,
  });
  useReactRenderWatchdog("SessionRoute", {
    selectedSessionId,
    selectedWorkspaceId,
    loading,
    workspaceCount: workspaces.length,
    sessionGroupCount: Object.keys(sessionsByWorkspaceId).length,
    commandPaletteOpen,
    modelPickerOpen: modelPicker.open,
  });

  const navigateToSessionForControl = useCallback((sessionId: string) => {
    const owner = Object.entries(sessionsByWorkspaceId).find(([, sessions]) =>
      (sessions ?? []).some((session) => session?.id === sessionId),
    )?.[0];
    navigateToWorkspaceSession(owner || selectedWorkspaceId, sessionId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId, sessionsByWorkspaceId]);

  const navigateToSessionRootForControl = useCallback(() => {
    navigateToWorkspaceSession(selectedWorkspaceId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId]);

  const openModelPickerForControl = useCallback(() => {
    // Opened while a conversation is visible: target that conversation so the
    // picker's checkmark and the selection it writes match the composer.
    setModelPickerSessionId(selectedSessionId || null);
    modelPicker.setOpen(true);
  }, [selectedSessionId]);

  useSessionControlActions({
    workspaces,
    sessionsByWorkspaceId,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedSessionId,
    canCreateTask,
    openworkClient: client,
    opencodeClient,
    endpointForWorkspace,
    navigateToSession: navigateToSessionForControl,
    navigateToSessionRoot: navigateToSessionRootForControl,
    createTaskInWorkspace: handleCreateTaskInWorkspace,
    openModelPicker: openModelPickerForControl,
    refreshRouteState,
  });

  const seedUnavailableModelControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.model_not_available.seed",
      label: "Seed an unavailable selected model",
      description: "Dev-only eval hook that selects a missing model and returns an available model to recover with. scope=default leaves the open conversation's remembered model untouched.",
      sideEffect: "mutation",
      disabled: !opencodeClient,
      args: [{ name: "scope", type: "string", description: "default | both (default: both)" }],
      execute: async (args) => {
        if (!opencodeClient) return { ok: false, error: "OpenCode client is not connected." };
        const scope = (args && typeof args === "object" && Reflect.get(args, "scope") === "default")
          ? "default"
          : "both";

        const providerList = await ensureProviderListQuery(getReactQueryClient(), {
          client: opencodeClient,
          baseUrl: opencodeBaseUrl,
          directory: selectedWorkspaceRoot || undefined,
          force: true,
        });
        const filteredProviderList = filterProviderList(providerList, disabledProviderIds);
        const availableProvider = getConnectedProviderItems(filteredProviderList)
          .filter((provider) => !isDesktopProviderBlocked({
            providerId: provider.id,
            checkRestriction: checkDesktopRestriction,
          }))
          .find((provider) => Object.keys(provider.models ?? {}).length > 0);
        const availableModelId = availableProvider ? Object.keys(availableProvider.models ?? {})[0] : undefined;
        const availableModel = availableProvider && availableModelId
          ? availableProvider.models[availableModelId]
          : undefined;

        if (!availableProvider || !availableModelId || !availableModel) {
          return { ok: false, error: "No available connected model found for eval recovery." };
        }

        const unavailableModel = nextEvalUnavailableModel(local.prefs.defaultModel);
        modelPicker.setQuery("");
        modelPicker.setRecentProviderIds(new Set());
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: unavailableModel,
          modelVariant: null,
        }));
        // Per-conversation memory is session-scoped: seeding "both" makes the
        // open conversation's own model unavailable; "default" reproduces the
        // workspace-switch state where only the global default is missing.
        if (scope === "both" && selectedSessionId) {
          useSessionModelStore.getState().setModel(selectedSessionId, unavailableModel, null);
        }

        return {
          scope,
          unavailableModel,
          availableModel: {
            providerID: availableProvider.id,
            providerName: availableProvider.name || availableProvider.id,
            modelID: availableModelId,
            title: availableModel.name || availableModelId,
          },
          sessionId: selectedSessionId,
          workspaceId: selectedWorkspaceId,
        };
      },
    };
  }, [checkDesktopRestriction, disabledProviderIds, local, modelPicker.setQuery, modelPicker.setRecentProviderIds, opencodeBaseUrl, opencodeClient, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot]);
  useControlAction(seedUnavailableModelControlAction);

  const seedActiveSessionSidebarControlAction = useMemo<OpenworkControlAction | null>(() => {
    if (!import.meta.env.DEV) return null;
    return {
      id: "eval.session_sidebar.seed_active",
      label: "Show the selected session as active",
      description: "Dev-only eval hook that displays the selected session activity spinner.",
      sideEffect: "mutation",
      disabled: !selectedWorkspaceId || !selectedSessionId,
      execute: () => {
        if (!selectedWorkspaceId || !selectedSessionId) {
          return { ok: false, error: "No session is selected." };
        }
        useSessionActivityStore.getState().setRunStatus(selectedWorkspaceId, selectedSessionId, "running");
        return { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId };
      },
    };
  }, [selectedSessionId, selectedWorkspaceId]);
  useControlAction(seedActiveSessionSidebarControlAction);

  const commandPaletteControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "command_palette.open",
    label: "Open the command palette",
    description: "Open the in-app command palette so the next choice is visible.",
    effects: { data: "none", ui: "dialog", external: false },
    sideEffect: "none",
    execute: () => setCommandPaletteOpen(true),
  }), []);
  useControlAction(commandPaletteControlAction);

  const addProviderControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "settings.provider.add",
    label: "Add a model provider",
    description: "Open the provider connection modal, optionally pre-filtered to a specific provider.",
    sideEffect: "mutation",
    requiresArgs: false,
    args: [
      { name: "providerId", type: "string" as const, required: false, description: "Provider id to pre-select, e.g. 'anthropic', 'openai', 'google'." },
    ],
    execute: async (rawArgs: unknown) => {
      const providerId = typeof rawArgs === "object" && rawArgs !== null
        ? (rawArgs as Record<string, unknown>).providerId
        : undefined;
      const preferred = typeof providerId === "string" ? providerId.trim() : undefined;
      if (sessionProviderAuthStore.isProviderAddRestricted(preferred)) {
        return { ok: false, error: t("providers.custom_providers_disabled") };
      }
      await sessionProviderAuthStore.openProviderAuthModal(
        preferred ? { preferredProviderId: preferred } : undefined,
      );
      return { ok: true, opened: "provider_auth_modal", preferredProviderId: preferred ?? null };
    },
  }), [sessionProviderAuthStore]);
  useControlAction(addProviderControlAction);

  const handleOpenProviderAuth = useCallback(() => {
    if (sessionProviderAuthStore.isProviderAddRestricted()) {
      restrictionNotice.show({
        title: t("restrictions.add_custom_providers_disabled_title"),
        message: t("restrictions.add_custom_providers_disabled_message"),
      });
      return;
    }

    // Pre-workspace (chat-first) there is no opencode client yet, so the
    // modal cannot load auth methods — fall back to the AI Providers page.
    void sessionProviderAuthStore.openProviderAuthModal({ returnFocusTarget: "composer" }).catch(() => {
      handleOpenSettings("/settings/ai");
    });
  }, [handleOpenSettings, restrictionNotice, sessionProviderAuthStore]);

  // "Connect more providers" in the compact model picker (and anything else
  // outside this route's prop tree) requests the provider auth modal here.
  useEffect(() => {
    const handler = () => handleOpenProviderAuth();
    window.addEventListener(openProviderAuthEvent, handler);
    return () => window.removeEventListener(openProviderAuthEvent, handler);
  }, [handleOpenProviderAuth]);

  const paletteSessionOptions = useMemo(
    () => buildCommandPaletteSessions(workspaces, sessionsByWorkspaceId, selectedWorkspaceId),
    [sessionsByWorkspaceId, selectedWorkspaceId, workspaces],
  );

  const paletteSessionModelSelection = selectedSessionId
    ? getSessionModelSelection(selectedSessionId)
    : null;
  const paletteSelectedModel = paletteSessionModelSelection?.model
    ?? local.prefs.defaultModel
    ?? undefined;
  const paletteSelectedModelBehavior = paletteSessionModelSelection
    ? (() => {
        const selected = paletteSessionModelSelection.model;
        const model = providerCatalog?.[selected.providerID]?.[selected.modelID];
        return model
          ? getModelBehaviorSummary(
              paletteSessionModelSelection.model.providerID,
              model,
              paletteSessionModelSelection.variant,
            ).value
          : paletteSessionModelSelection.variant;
      })()
    : modelVariantValue;

  const applySessionRouteModelSelection = useCallback((
    next: ModelRef,
    targetSessionId: string | null,
    behavior?: { value: string | null },
  ) => {
    const explicitBehavior = behavior !== undefined;
    useModelCollectionsStore.getState().recordRecent(next);
    if (targetSessionId) {
      const sessionStore = useSessionModelStore.getState();
      sessionStore.setModel(targetSessionId, next, explicitBehavior ? behavior.value : undefined);
      if (explicitBehavior) sessionStore.setVariant(targetSessionId, behavior.value);
    }
    local.setPrefs((previous) => ({
      ...previous,
      defaultModel: next,
      modelVariant: explicitBehavior
        ? behavior.value
        : previous.defaultModel?.providerID === next.providerID && previous.defaultModel.modelID === next.modelID
          ? previous.modelVariant
          : null,
    }));
    focusPromptSoon();
  }, [local]);

  // Refresh the non-tab fields of the nav ref during render. The `options`
  // field is maintained by the `onSessionTabsChange` callback from SessionPage.
  sessionTabNavRef.current = {
    options: sessionTabNavRef.current.options,
    workspaceId: selectedWorkspaceId,
    sessionId: selectedSessionId,
    navigate: navigateToWorkspaceSession,
  };

  const paletteSessionGroups = useMemo<SessionGroupOption[]>(
    () => selectedWorkspaceGroupState?.groups ?? [],
    [selectedWorkspaceGroupState?.groups],
  );

  const currentSessionForGroupMove = useMemo(() => {
    if (!selectedWorkspaceId || !selectedSessionId) return null;
    return paletteSessionOptions.find(
      (session) => session.workspaceId === selectedWorkspaceId && session.sessionId === selectedSessionId,
    ) ?? null;
  }, [paletteSessionOptions, selectedSessionId, selectedWorkspaceId]);

  const currentSessionGroupId = selectedSessionId
    ? selectedWorkspaceGroupState?.assignments[selectedSessionId] ?? null
    : null;

  const handleMoveCurrentSessionToGroup = useCallback((groupId: string) => {
    if (!selectedWorkspaceId || !selectedSessionId) return;
    assignSessionToGroup(selectedWorkspaceId, selectedSessionId, groupId);
  }, [assignSessionToGroup, selectedSessionId, selectedWorkspaceId]);

  const sessionSearchFetcher = useMemo<SessionMessageFetcher | null>(() => {
    if (!client) return null;
    // Cap the transcript fetch to keep multi-workspace scans fast; matches in
    // anything older than the most recent 400 messages are traded away for
    // responsiveness.
    return async (workspaceId: string, sessionId: string) => {
      const workspace = workspaces.find((item) => item.id === workspaceId);
      const endpoint = endpointForWorkspace(workspace);
      if (!endpoint) throw new Error("Workspace runtime is not connected.");
      return getNativeSessionMessages(endpoint, sessionId, { limit: 400 });
    };
  }, [client, endpointForWorkspace, workspaces]);

  const sessionSearchPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-search.open",
    title: "Search session messages",
    detail: "Deep search every session, including message content",
    meta: "Cmd/Ctrl+Shift+F",
    searchText: "search find sessions messages history transcript content",
    action: () => {
      setCommandPaletteOpen(false);
      setSessionSearchOpen(true);
    },
  }), []);

  const sessionFindPaletteItem = useMemo<PaletteItem | null>(() => {
    if (!selectedSessionId) return null;
    return {
      id: "session-find.open",
      title: "Find in conversation",
      detail: "Search within the current conversation",
      meta: "Cmd/Ctrl+F",
      searchText: "find search current conversation session messages transcript",
      action: () => {
        setCommandPaletteOpen(false);
        useSessionFindStore.getState().openFind({ sessionId: selectedSessionId });
      },
    };
  }, [selectedSessionId]);

  const terminalPaletteItems = useMemo<PaletteItem[]>(() => platform.capabilities.terminal ? [
    {
      id: "terminal.toggle",
      title: terminalOpen ? "Hide terminal" : "Show terminal",
      detail: "Toggle the integrated terminal panel for this workspace",
      meta: "Cmd/Ctrl+J",
      searchText: "terminal shell command line console show hide toggle",
      action: () => {
        setCommandPaletteOpen(false);
        setTerminalOpen((value) => !value);
      },
    },
  ] : [], [platform.capabilities.terminal, terminalOpen]);

  const developerModePaletteItem = useMemo<PaletteItem>(() => ({
    id: "developer-mode.toggle",
    title: developerMode ? t("settings.disable_developer_mode") : t("settings.enable_developer_mode"),
    detail: t("settings.developer_mode_desc"),
    meta: developerMode ? "On" : "Off",
    searchText: "developer dev mode debug diagnostics toggle enable disable",
    action: () => {
      setCommandPaletteOpen(false);
      setDeveloperMode((current) => {
        const next = !current;
        try { window.localStorage.setItem("openwork.developerMode", next ? "1" : "0"); } catch {}
        return next;
      });
    },
  }), [developerMode]);

  const buildCommandDiagnosticsBundle = useCallback(() => buildDiagnosticsBundleJson({
    anyActiveRuns: activeReloadBlockingSessions.length > 0,
    canReloadWorkspace: reloadCoordinator.canReloadWorkspaceEngine,
    clientConnected: canCreateTask,
    developerMode,
    hostInfo: openworkServerHostInfoState,
    openworkServerStatus: client ? "connected" : "disconnected",
    openworkServerUrl: baseUrl,
    runtimeWorkspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
  }), [
    activeReloadBlockingSessions.length,
    baseUrl,
    canCreateTask,
    client,
    developerMode,
    openworkServerHostInfoState,
    reloadCoordinator.canReloadWorkspaceEngine,
    selectedWorkspaceEndpoint?.workspaceId,
  ]);

  const diagnosticsCopyPaletteItem = useMemo<PaletteItem>(() => ({
    id: "diagnostics.copy",
    title: t("session.cmd_diagnostics_copy_title"),
    detail: t("session.cmd_diagnostics_copy_detail"),
    searchText: "logs share diagnostics debug support bundle troubleshoot copy report issue",
    action: async () => {
      setCommandPaletteOpen(false);
      try {
        const json = await buildCommandDiagnosticsBundle();
        await navigator.clipboard.writeText(json);
        toast.success(t("session.diagnostics_copied"));
      } catch (error) {
        toast.error(t("session.diagnostics_failed"), { description: describeRouteError(error) });
      }
    },
  }), [buildCommandDiagnosticsBundle]);

  const diagnosticsExportPaletteItem = useMemo<PaletteItem>(() => ({
    id: "diagnostics.export",
    title: t("session.cmd_diagnostics_export_title"),
    detail: t("session.cmd_diagnostics_export_detail"),
    searchText: "logs export diagnostics debug support bundle save file json download",
    action: async () => {
      setCommandPaletteOpen(false);
      try {
        const json = await buildCommandDiagnosticsBundle();
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        downloadTextAsFile(`openwork-diagnostics-${timestamp}.json`, json, "application/json");
        toast.success(t("session.diagnostics_exported"));
      } catch (error) {
        toast.error(t("session.diagnostics_failed"), { description: describeRouteError(error) });
      }
    },
  }), [buildCommandDiagnosticsBundle]);

  const nextSessionTabPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-tab.next",
    title: "Next session tab",
    detail: "Switch to the next session in this workspace",
    meta: "Cmd/Ctrl+T",
    searchText: "next session tab switch forward",
    action: () => {
      setCommandPaletteOpen(false);
      goToNextSessionTab();
    },
  }), [goToNextSessionTab]);

  const prevSessionTabPaletteItem = useMemo<PaletteItem>(() => ({
    id: "session-tab.previous",
    title: "Previous session tab",
    detail: "Switch to the previous session in this workspace",
    meta: "Cmd/Ctrl+Shift+T",
    searchText: "previous session tab switch back",
    action: () => {
      setCommandPaletteOpen(false);
      goToPrevSessionTab();
    },
  }), [goToPrevSessionTab]);

  const reloadConfigPaletteItem = useMemo<PaletteItem>(() => ({
    id: "reload-opencode-config",
    title: t("session.cmd_reload_config_title"),
    detail: t("session.cmd_reload_config_detail"),
    meta: reloadCoordinator.canReloadWorkspaceEngine
      ? t("config.reload_engine")
      : t("system.reload_unavailable"),
    searchText: "reload opencode config providers models mcp jsonc refresh re-read engine restart",
    action: () => {
      setCommandPaletteOpen(false);
      if (!reloadCoordinator.canReloadWorkspaceEngine) return;
      void reloadCoordinator.reloadWorkspaceEngine();
    },
  }), [reloadCoordinator.canReloadWorkspaceEngine, reloadCoordinator.reloadWorkspaceEngine]);

  const handleReorderWorkspaces = useCallback((workspaceIds: string[]) => {
    const activeWorkspaceIds = new Set(workspacesRef.current.map((workspace) => workspace.id));
    const nextOrderIds: string[] = [];
    const nextOrderIdSet = new Set<string>();

    for (const id of workspaceIds) {
      if (!activeWorkspaceIds.has(id) || nextOrderIdSet.has(id)) continue;
      nextOrderIds.push(id);
      nextOrderIdSet.add(id);
    }

    for (const workspace of workspacesRef.current) {
      if (nextOrderIdSet.has(workspace.id)) continue;
      nextOrderIds.push(workspace.id);
      nextOrderIdSet.add(workspace.id);
    }

    workspaceOrderIdsRef.current = nextOrderIds;
    setWorkspaceOrderIds(nextOrderIds);
    writeWorkspaceOrderIds(nextOrderIds);
    setWorkspaces((current) => orderRouteWorkspaces(current, nextOrderIds));
  }, []);

  const handleArchiveSession = useCallback(
    async (sessionId: string, archived: boolean) => {
      if (!opencodeClient) return;
      // The sidebar lists sessions from every workspace, so resolve the
      // session's owning workspace instead of assuming the selected one —
      // session.update needs the directory the session actually lives in.
      const ownerWorkspace = workspaceSessionGroups.find((group) =>
        group.sessions.some((session) => session?.id === sessionId),
      )?.workspace;
      try {
        await setSessionArchived(
          opencodeClient,
          sessionId,
          archived,
          ownerWorkspace?.path || selectedWorkspaceRoot || undefined,
        );
        if (ownerWorkspace) await reloadWorkspaceSessions(ownerWorkspace.id);
        await refreshRouteState();
      } catch (error) {
        console.error("[session-route] archive session failed", error);
        toast.error(
          archived
            ? t("session_management.archive_failed")
            : t("session_management.unarchive_failed"),
          { description: describeRouteError(error) },
        );
      }
    },
    [opencodeClient, refreshRouteState, reloadWorkspaceSessions, selectedWorkspaceRoot, workspaceSessionGroups],
  );

  const handleCreateWorkspace = useCallback(async (
    preset: WorkspacePreset,
    folder: string | null,
    options?: CreateWorkspaceOptions,
  ) => {
    if (!folder) return;
    const projectLabel = options?.projectLabel?.trim() ?? "";
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      let list: WorkspaceList | null = null;
      let createdOnServer = false;
      if (client) {
        list = await client
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .then((serverList) => {
            createdOnServer = true;
            return serverList;
          })
          .catch(() => null);
      }
      if (!list) {
        throw new Error("OpenWork server is unavailable. Start or reconnect the server before creating a workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      let targetWorkspaceId = createdId;
      let targetWorkspace = list.workspaces.find((workspace: WorkspaceInfo) => workspace.id === createdId) ?? null;
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      // First workspace on a fresh install: the OpenWork server was started
      // engine-less (it only spawns OpenCode at boot when a workspace already
      // exists), so sessions would hang forever. This boots the engine when
      // it isn't running, same as the old /welcome flow did.
      let sessionBaseUrl = baseUrl;
      let sessionToken = token;
      if (targetWorkspace && isDesktopRuntime()) {
        await ensureDesktopLocalOpenworkConnection({
          route: "session",
          workspace: targetWorkspace,
          allWorkspaces: list.workspaces,
        }).catch(() => undefined);
        // The engine boot can restart the server with fresh tokens; re-resolve
        // so the first-session creation below doesn't use stale credentials.
        const fresh = await resolveOpenworkConnection().catch(() => null);
        if (fresh?.normalizedBaseUrl && fresh.resolvedToken) {
          sessionBaseUrl = fresh.normalizedBaseUrl;
          sessionToken = fresh.resolvedToken;
        }
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      if (targetWorkspaceId) {
        const workspacePath = targetWorkspace?.path?.trim() || folder;
        const firstTaskPrompt = options?.firstTaskPrompt?.trim() ?? "";
        const firstTaskAttachments = options?.firstTaskAttachments ?? [];
        // A workspace registry mutation must not eagerly instantiate an
        // OpenCode directory. Chat-first creation still needs a session for
        // its supplied prompt; ordinary creation lands on the New task state.
        const session = createdOnServer && sessionBaseUrl && sessionToken && (firstTaskPrompt || firstTaskAttachments.length > 0)
          ? await createClient(
              `${(buildOpenworkWorkspaceBaseUrl(sessionBaseUrl, targetWorkspaceId) ?? sessionBaseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token: sessionToken, mode: "openwork" },
            ).session.create({ directory: workspacePath || undefined })
              .then((result) => unwrap(result))
              .catch(() => null)
          : null;
        setLegacySelectedWorkspaceId(targetWorkspaceId);
        writeActiveWorkspaceId(targetWorkspaceId);
        if (projectLabel) {
          writeWorkspaceProjectDimension(targetWorkspaceId, {
            label: projectLabel,
          });
        }
        captureAnalyticsEvent("workspace_created", { workspace_type: "local" });
        if (session?.id) {
          captureAnalyticsEvent("task_created", { source: "workspace_created", workspace_type: "local" });
          if (firstTaskPrompt) {
            // Attachment chips only survive in-memory (File objects), so the
            // persisted fallback draft drops their tokens.
            saveSessionDraft(sessionDraftScope, targetWorkspaceId, session.id, { text: firstTaskPrompt.replace(/\[attachment [^\]]+\]/g, "").trim(), mode: "prompt" });
            claimComposerSessionDraftScope(
              session.id,
              sessionDraftScopeKey(sessionDraftScope, targetWorkspaceId, session.id),
            );
            // The composer reads its draft from the composer state store, not
            // the persisted draft store — seed both so the prompt shows up.
            useComposerStateStore.getState().setDraft(session.id, firstTaskPrompt);
            if (firstTaskAttachments.length) {
              useComposerStateStore.getState().setAttachments(session.id, firstTaskAttachments);
            }
            // One-step run: the session surface sends the seeded draft itself.
            markComposerAutoSend(session.id);
          }
          writeLastSessionFor(targetWorkspaceId, session.id);
          rememberPendingCreatedSession(targetWorkspaceId, session.id);
          setSessionsByWorkspaceId((current) => {
            const next = {
              ...current,
              [targetWorkspaceId]: [session, ...(current[targetWorkspaceId] ?? [])],
            };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
        }
        navigateToWorkspaceSession(targetWorkspaceId, session?.id ?? null, { replace: true });
        if (session?.id) focusPromptSoon();
      }
    } catch (error) {
      setCreateWorkspaceError(describeWorkspaceCreateError(error));
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [baseUrl, client, local, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession, token]);

  /**
   * Chat-first onboarding: the empty-state composer creates a default chat
   * workspace under the user's home folder instead of asking where to put
   * it. Falls back to the create-workspace modal off desktop.
   */
  const handleChatFirstTask = useCallback((prompt: string, attachments?: ComposerAttachment[]) => {
    void (async () => {
      if (!isDesktopRuntime()) {
        // The cloud workspace is provisioned by Den; boot takeover covers the pre-attach state.
        if (!canCreateWorkspaces()) return;
        handleOpenCreateWorkspace();
        return;
      }
      const home = await getDesktopHomeDir().catch(() => "");
      if (!home) {
        handleOpenCreateWorkspace();
        return;
      }
      const folder = await joinDesktopPath(home, "OpenWork Chat").catch(() => "");
      if (!folder) {
        handleOpenCreateWorkspace();
        return;
      }
      await handleCreateWorkspace("starter", folder, { firstTaskPrompt: prompt, firstTaskAttachments: attachments ?? [] });
    })();
  }, [handleCreateWorkspace, handleOpenCreateWorkspace]);

  const createWorkspaceControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "workspace.create",
    label: "Create a local workspace",
    description: "Create a workspace at the given folder path without showing the file picker dialog, optionally labeling its project for analytics.",
    sideEffect: "mutation",
    requiresArgs: true,
    args: [
      { name: "path", type: "string", required: true, description: "Absolute folder path for the new workspace." },
      { name: "projectLabel", type: "string", required: false, description: "Optional project name used to group the workspace's sessions in analytics." },
    ],
    execute: async (args) => {
      if (!canCreateWorkspaces()) return { ok: false, error: "workspace creation is unavailable" };
      const parsed = args as { path?: string; projectLabel?: string } | undefined;
      const folder = parsed?.path?.trim();
      if (!folder) return { ok: false, error: "path is required" };
      const trimmedLabel = parsed?.projectLabel?.trim() ?? "";
      await handleCreateWorkspace("starter", folder, trimmedLabel ? { projectLabel: trimmedLabel } : undefined);
      return { path: folder };
    },
  }), [handleCreateWorkspace]);
  useControlAction(createWorkspaceControlAction);

  const handleCreateRemoteWorkspace = useCallback(async (input: {
    openworkHostUrl?: string | null;
    openworkToken?: string | null;
    directory?: string | null;
    displayName?: string | null;
  }) => {
    const baseUrlValue = input.openworkHostUrl?.trim() ?? "";
    if (!baseUrlValue) return false;
    setCreateWorkspaceRemoteBusy(true);
    setCreateWorkspaceRemoteError(null);
    try {
      const remoteType: "openwork" = "openwork";
      const payload = {
        baseUrl: baseUrlValue,
        openworkHostUrl: baseUrlValue,
        openworkToken: input.openworkToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType,
      };
      let list: WorkspaceList | null = null;
      if (isDesktopRuntime()) {
        list = await workspaceCreateRemote(payload);
      } else if (client) {
        list = await client.createRemoteWorkspace(payload).catch(() => null);
      }
      if (!list) {
        throw new Error("OpenWork server is unavailable. Start or reconnect the server before connecting a remote workspace.");
      }
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      return true;
    } catch (error) {
      setCreateWorkspaceRemoteError(error instanceof Error ? error.message : t("app.unknown_error"));
      return false;
    } finally {
      setCreateWorkspaceRemoteBusy(false);
    }
  }, [client, local, refreshRouteState]);

  return (
    <WorkspaceProvider
      client={opencodeClient}
      opencodeBaseUrl={opencodeBaseUrl}
      openworkServerClient={selectedWorkspaceEndpoint?.client ?? null}
      workspaceId={selectedWorkspaceEndpoint?.workspaceId ?? ""}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
    >
    {opencodeClient && selectedWorkspaceEndpoint && opencodeBaseUrl && selectedWorkspaceServerToken ? (
      <ReactSessionRuntime
        // Use the server-side workspace id (the one without the `rem_`
        // prefix) so the React Query cache keys session-sync writes match
        // the keys SessionSurface reads from. Otherwise events arrive but
        // the UI never sees them and gets stuck on "thinking".
        workspaceId={selectedWorkspaceEndpoint.workspaceId}
        sessionId={selectedSessionId}
        activeSessionIds={activeSelectedWorkspaceSessionIds}
        opencodeBaseUrl={opencodeBaseUrl}
        openworkToken={selectedWorkspaceServerToken}
        onSessionCreated={handleRuntimeSessionCreated}
        onSessionUpdated={handleRuntimeSessionUpdated}
        onSessionDeleted={handleRuntimeSessionDeleted}
      />
    ) : null}
    <SessionPage
      sessionNumberShortcuts={sessionNumberShortcuts}
      selectedSessionId={selectedSessionId}
      selectedWorkspaceId={selectedWorkspaceId}
      selectedWorkspaceDisplay={selectedWorkspace ? {
        id: selectedWorkspace.id,
        name: selectedWorkspace.name ?? undefined,
        displayName: selectedWorkspace.displayNameResolved,
        workspaceType: selectedWorkspace.workspaceType,
      } : { workspaceType: "local" }}
      selectedWorkspaceRoot={selectedWorkspaceRoot}
      selectedWorkspaceError={selectedWorkspaceError}
      runtimeWorkspaceId={selectedWorkspaceEndpoint?.workspaceId || null}
      opencodeBaseUrl={opencodeBaseUrl}
      workspaces={workspaces}
      clientConnected={canCreateTask}
      openworkServerStatus={client ? "connected" : "disconnected"}
      openworkServerClient={selectedWorkspaceEndpoint?.client ?? client}
      environmentClient={client}
      openworkServerToken={selectedWorkspaceServerToken}
      developerMode={developerMode}
      headerStatus={
        canCreateTask || (activeComposerTargetsSession && !selectedWorkspaceError && activeComposerAvailability.status === "available")
          ? t("status.connected")
          : (modelUnavailableMessage ?? t("session.loading_detail"))
      }
      busyHint={organizationModelsEmpty ? t("models.organization_models_empty") : effectiveLoading ? t("session.loading_detail") : null}
      startupPhase={effectiveLoading ? "nativeInit" : "ready"}
      providerConnectedIds={providerConnectedIds}
      hasUsableModel={hasUsableModel}
      providers={providers}
      mcpConnectedCount={mcpConnectedCount}
      onSendFeedback={() => {
        platform.openLink(
          buildFeedbackUrl({
            entrypoint: "status-bar",
          }),
        );
      }}
      onOpenSettings={() => handleOpenSettings("/settings/general")}
      onOpenExtensions={() => handleOpenExtensions()}
      onOpenProviderAuth={handleOpenProviderAuth}
      onChatFirstTask={handleChatFirstTask}
      chatFirstBusy={createWorkspaceBusy}
      newTaskComposer={newTaskComposerContext}
      providerAuthModal={sessionProviderAuthSnapshot.providerAuthModalOpen ? {
        open: true,
        loading: false,
        submitting: sessionProviderAuthSnapshot.providerAuthBusy,
        error: sessionProviderAuthSnapshot.providerAuthError,
        preferredProviderId: sessionProviderAuthSnapshot.providerAuthPreferredProviderId,
        workerType: sessionProviderAuthSnapshot.providerAuthWorkerType,
        providers: sessionProviderAuthSnapshot.providerAuthProviders.filter(
          (provider) => !isDesktopProviderBlocked({ providerId: provider.id, checkRestriction: checkDesktopRestriction }),
        ),
        connectedProviderIds: providerConnectedIds,
        authMethods: Object.fromEntries(
          Object.entries(sessionProviderAuthSnapshot.providerAuthMethods).filter(
            ([providerId]) => !isDesktopProviderBlocked({ providerId, checkRestriction: checkDesktopRestriction }),
          ),
        ),
        onSelect: sessionProviderAuthStore.startProviderAuth,
        onSubmitApiKey: async (providerId, apiKey) => {
          const result = await sessionProviderAuthStore.submitProviderApiKey(providerId, apiKey);
          modelPicker.setRecentProviderIds(new Set([providerId]));
          modelPicker.setQuery("");
          modelPicker.setOpen(true);
          return result;
        },
        onSubmitOAuth: sessionProviderAuthStore.completeProviderAuthOAuth,
        onRefreshProviders: sessionProviderAuthStore.refreshProviders,
        onClose: () => sessionProviderAuthStore.closeProviderAuthModal(),
      } : null}
      settingsSlot={
        <SettingsSurface
          embedded
          initialPath="extensions"
          workspaceId={selectedWorkspaceId}
          onClose={() => {
            try {
              window.dispatchEvent(new CustomEvent("openwork-close-right-pane"));
            } catch {
              // ignore
            }
          }}
        />
      }
      primaryTitle={automationsRouteActive ? "Automations" : dashboardRouteActive ? "Dashboard" : undefined}
      primarySlot={automationsRouteActive ? (
        <AutomationsPage providerCatalog={providerCatalog} workspaceId={selectedWorkspaceId} />
      ) : dashboardRouteActive ? (
        <WorkspaceProvider
          client={opencodeClient}
          opencodeBaseUrl={opencodeBaseUrl}
          openworkServerClient={dashboardEndpoint?.client ?? null}
          workspaceId={dashboardEndpoint?.workspaceId ?? ""}
          selectedWorkspaceRoot={selectedWorkspaceRoot}
        >
          <DashboardPage fallbackEndpoints={dashboardFallbackEndpoints} />
        </WorkspaceProvider>
      ) : undefined}
      terminalOpen={terminalOpen}
      onTerminalOpenChange={setTerminalOpen}
      onSessionTabsChange={(tabs) => {
        sessionTabNavRef.current = { ...sessionTabNavRef.current, options: tabs };
      }}
      sidebar={{
        workspaceSessionGroups,
        selectedWorkspaceId,
        selectedSessionId,
        developerMode: false,
        sessionStatusById: sidebarSessionStatusById,
        connectingWorkspaceId: null,
        workspaceConnectionStateById,
        newTaskDisabled: !canCreateTask,
        sidebarHydratedFromCache: Object.values(sessionsByWorkspaceId).some((list) => list.length > 0),
        startupPhase: effectiveLoading ? "nativeInit" : "ready",
        automationsActive: automationsRouteActive,
        automationsNeedAttention,
        onOpenAutomations: automationsNavigationAvailable
          ? () => {
              navigate(automationsRoute());
            }
          : undefined,
        dashboardActive: dashboardRouteActive,
        onOpenDashboard: mcpAppsDashboardEnabled
          ? () => {
              navigate(dashboardRoute());
            }
          : undefined,
        onSelectWorkspace: async (workspaceId) => {
          if (workspaceId === selectedWorkspaceId) return true;
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          // Route adoption owns desktop persistence and server activation.
          // Centralizing those effects lets rapid navigation coalesce to the
          // last route instead of racing stale IPC and engine reloads.
          // If we remember what the user last opened here and that session
          // still exists in our local list, navigate. Otherwise stay put.
          const remembered = readLastSessionFor(workspaceId);
          if (remembered && remembered !== selectedSessionId) {
            const known = sessionsByWorkspaceId[workspaceId];
            if (known?.some((session) => session?.id === remembered)) {
              navigateToWorkspaceSession(workspaceId, remembered);
            } else {
              navigateToWorkspaceSession(workspaceId);
            }
          } else {
            navigateToWorkspaceSession(workspaceId);
          }
          return true;
        },
        onOpenSession: (workspaceId, sessionId) => {
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, sessionId);
          navigateToWorkspaceSession(workspaceId, sessionId);
        },
        onPrefetchSession: () => {},
        onCreateTaskInWorkspace: (workspaceId, groupId) => {
          void handleCreateTaskInWorkspace(workspaceId).then((sessionId) => {
            if (sessionId && groupId) {
              sessionManagementStore.getState().assignGroup(workspaceId, sessionId, groupId);
            }
          });
        },
        onCreateTaskWithPrompt: (workspaceId, prompt, attachments) => {
          void (async () => {
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (!workspace) return;
            const endpoint = endpointForWorkspace(workspace);
            if (!endpoint?.token) return;
            const workspaceClient = createClient(
              endpoint.opencodeBaseUrl,
              workspace.path?.trim() || undefined,
              { token: endpoint.token, mode: "openwork" },
            );
            try {
              const session = unwrap(
                await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
              );
              if (workspaceId === selectedWorkspaceId) {
                void refreshCloudProviderSync("new_chat");
              }
              const firstTaskPrompt = prompt.trim();
              if (firstTaskPrompt) {
                const firstTaskAttachments = attachments ?? [];
                // Attachment chips only survive in-memory (File objects), so the
                // persisted fallback draft drops their tokens.
                saveSessionDraft(sessionDraftScope, workspaceId, session.id, { text: firstTaskPrompt.replace(/\[attachment [^\]]+\]/g, "").trim(), mode: "prompt" });
                claimComposerSessionDraftScope(
                  session.id,
                  sessionDraftScopeKey(sessionDraftScope, workspaceId, session.id),
                );
                // The composer reads its draft from the composer state store,
                // not the persisted draft store — seed both.
                useComposerStateStore.getState().setDraft(session.id, firstTaskPrompt);
                if (firstTaskAttachments.length) {
                  useComposerStateStore.getState().setAttachments(session.id, firstTaskAttachments);
                }
                // One-step run: the session surface sends the seeded draft itself.
                markComposerAutoSend(session.id);
              }
              writeActiveWorkspaceId(workspaceId || null);
              writeLastSessionFor(workspaceId, session.id);
              rememberPendingCreatedSession(workspaceId, session.id);
              applyLastUsedModelToSession(session.id);
              setSessionsByWorkspaceId((current) => ({
                ...current,
                [workspaceId]: [session, ...(current[workspaceId] ?? [])],
              }));
              navigateToWorkspaceSession(workspaceId, session.id);
              focusPromptSoon();
            } catch {
              // Fall back to normal task creation without prompt
              void handleCreateTaskInWorkspace(workspaceId);
            }
          })();
        },
        onOpenRenameWorkspace: handleOpenRenameWorkspace,
        onShareWorkspace: handleShareWorkspace,
        onRevealWorkspace: (id) => void handleRevealWorkspace(id),
        onRecoverWorkspace: (workspaceId) => runRemoteWorkspaceConnectionCheck(workspaceId, "recover"),
        onTestWorkspaceConnection: (workspaceId) => runRemoteWorkspaceConnectionCheck(workspaceId, "test"),
        onEditWorkspaceConnection: remoteWorkspaceConnectionEditor.open,
        onForgetWorkspace: (id) => void handleForgetWorkspace(id),
        onOpenCreateWorkspace: handleOpenCreateWorkspace,
        onOpenSessionSearch: () => setSessionSearchOpen(true),
        onReorderWorkspaces: handleReorderWorkspaces,
      }}
      surface={surfaceProps}
      resolvePaneRuntime={resolvePaneRuntime}
      history={{
        canUndo: false,
        canRedo: false,
        busyAction: null,
        onUndo: () => {},
        onRedo: () => {},
      }}
      todos={todos}
      sessionLoadingById={(sessionId) => effectiveLoading && Boolean(sessionId && sessionId === selectedSessionId)}
      shareWorkspaceModal={
        shareWorkspaceState.shareWorkspaceOpen
          ? {
              open: true,
              onClose: shareWorkspaceState.closeShareWorkspace,
              workspaceName: shareWorkspaceState.shareWorkspaceName,
              workspaceDetail: shareWorkspaceState.shareWorkspaceDetail,
              fields: shareWorkspaceState.shareFields,
              remoteAccess:
                isDesktopRuntime() && shareWorkspaceState.shareWorkspace?.workspaceType === "local"
                  ? {
                      enabled: openworkServerSettings.remoteAccessEnabled === true,
                      busy: remoteAccessRestart.busy,
                      error: remoteAccessRestart.error,
                      status: remoteAccessRestart.status,
                      onSave: handleSaveShareRemoteAccess,
                    }
                  : undefined,
              note: shareWorkspaceState.shareNote,
              onExportConfig:
                shareWorkspaceState.exportDisabledReason === null
                  ? () => {
                      const id = shareWorkspaceState.shareWorkspaceId;
                      if (!id) return;
                      void handleExportWorkspaceConfig(id);
                    }
                  : undefined,
              exportDisabledReason: shareWorkspaceState.exportDisabledReason,
            }
          : null
      }
      activePermission={activePermission}
      permissionReplyBusy={permissionReplyBusy}
      respondPermission={respondPermission}
      activeQuestion={activeQuestion}
      questionReplyBusy={questionReplyBusy}
      respondQuestion={respondQuestion}
      safeStringify={safeStringify}
      onRenameSession={
        opencodeClient
          ? async (sessionId, nextTitle) => {
              const trimmed = nextTitle.trim();
              if (!trimmed) return;
              await opencodeClient.session.update({
                sessionID: sessionId,
                title: trimmed,
                directory: selectedWorkspaceRoot || undefined,
              });
              await refreshRouteState();
            }
          : undefined
      }
      onDeleteSession={
        client && selectedWorkspaceId
          ? async (sessionId) => {
              const endpoint = endpointForWorkspace(selectedWorkspace);
              if (!endpoint) return;
              await deleteNativeSession(endpoint, sessionId);
              if (selectedSessionId === sessionId) {
                navigateToWorkspaceSession(selectedWorkspaceId);
              }
              await refreshRouteState();
            }
          : undefined
      }
      onArchiveSession={opencodeClient ? handleArchiveSession : undefined}
      statusBar={{
        // No per-session loading state here: the account row renders only
        // app-scoped facts. Session loading lives in the pane; an unresolved
        // model surfaces in the composer where the person can act on it.
        reloadBusy: reloadCoordinator.reloadBusy,
        reloadError: reloadCoordinator.reloadError,
        openWorkConnectState: sessionMcpMaintenance,
      }}
      notFoundMessage={gatedRouteNotFoundMessage}
      mainContentTakeover={
        extensionsMainOpen ? (
          <SettingsSurface
            standaloneExtensions
            workspaceId={selectedWorkspaceId || undefined}
          />
        ) : cloudWorkspaceMainContentTakeover
      }
      mainContentTitle={extensionsMainOpen ? t("settings.tab_extensions") : undefined}
      extensionsActive={extensionsMainOpen}
      onAccessibleTargetsChange={setPaletteAccessibleTargets}
    />
    <CreateWorkspaceModal
      open={createWorkspaceOpen}
      onClose={() => {
        setCreateWorkspaceOpen(false);
        setCreateWorkspaceError(null);
      }}
      onConfirm={handleCreateWorkspace}
      onConfirmRemote={handleCreateRemoteWorkspace}
      onPickFolder={async () => singlePickedDirectory(await pickDirectory({ title: t("onboarding.authorize_folder") }))}
      submitting={createWorkspaceBusy}
      localError={createWorkspaceError}
      localDisabled={!platform.capabilities.nativeFilePicker}
      localDisabledReason={
        platform.capabilities.nativeFilePicker
          ? undefined
          : t("app.local_disabled_reason")
      }
      remoteSubmitting={createWorkspaceRemoteBusy}
      remoteError={createWorkspaceRemoteError}
    />
    <CreateRemoteWorkspaceModal
      open={remoteWorkspaceConnectionEditor.workspace !== null}
      onClose={remoteWorkspaceConnectionEditor.close}
      onConfirm={(input) => void remoteWorkspaceConnectionEditor.save(input)}
      initialValues={remoteWorkspaceConnectionEditor.initialValues}
      submitting={remoteWorkspaceConnectionEditor.busy}
      error={remoteWorkspaceConnectionEditor.error}
      title={t("dashboard.edit_remote_workspace_title")}
      subtitle={t("dashboard.edit_remote_workspace_subtitle")}
      confirmLabel={t("dashboard.edit_remote_workspace_confirm")}
    />
    <RenameWorkspaceModal
      open={renameWorkspaceId !== null}
      title={renameWorkspaceTitle}
      busy={renameWorkspaceBusy}
      canSave={!renameWorkspaceBusy && renameWorkspaceTitle.trim().length > 0}
      onClose={() => {
        if (renameWorkspaceBusy) return;
        setRenameWorkspaceId(null);
        setRenameWorkspaceTitle("");
      }}
      onSave={() => void handleSaveRenameWorkspace()}
      onTitleChange={setRenameWorkspaceTitle}
    />
    <CommandPalette
      open={commandPaletteOpen}
      onClose={() => setCommandPaletteOpen(false)}
      onCreateNewSession={() => {
        if (selectedWorkspaceId) {
          void handleCreateTaskInWorkspace(selectedWorkspaceId);
        }
      }}
      onOpenSession={(workspaceId, sessionId) => navigateToWorkspaceSession(workspaceId, sessionId)}
      currentSession={selectedSessionId ? { workspaceId: selectedWorkspaceId, sessionId: selectedSessionId } : null}
      onOpenSessionInSplit={(workspaceId, sessionId) => {
        const option = paletteSessionOptions.find((candidate) => (
          candidate.workspaceId === workspaceId && candidate.sessionId === sessionId
        ));
        const tab = {
          workspaceId,
          sessionId,
          title: option?.title,
          workspaceTitle: option?.workspaceTitle ?? workspaceId,
        };
        const workbench = useWorkbenchStore.getState();
        workbench.openTab(tab);
        workbench.setSplit(tab);
      }}
      onOpenSettings={(route) => handleOpenSettings(route ?? "/settings/general")}
      onOpenExtensions={() => handleOpenExtensions()}
      modelOptions={modelPicker.options}
      selectedModel={paletteSelectedModel}
      selectedModelBehavior={paletteSelectedModelBehavior}
      onSelectModel={(next, behavior) => {
        applySessionRouteModelSelection(next, selectedSessionId || null, { value: behavior });
      }}
      selectedModelLabel={modelLabel}
      accessibleTargets={paletteAccessibleTargets}
      onOpenAccessibleTarget={(target) => {
        try {
          window.dispatchEvent(new CustomEvent("openwork-open-accessible-target", { detail: target }));
        } catch {
          // ignore event dispatch failures
        }
      }}
      onHideAccessibleTarget={(target) => {
        try {
          window.dispatchEvent(new CustomEvent("openwork-hide-accessible-target", { detail: target }));
        } catch {
          // ignore event dispatch failures
        }
      }}
      sessions={paletteSessionOptions}
      sessionGroups={paletteSessionGroups}
      currentSessionForGroupMove={currentSessionForGroupMove}
      currentSessionGroupId={currentSessionGroupId}
      onMoveCurrentSessionToGroup={handleMoveCurrentSessionToGroup}
      extraItems={[...(sessionFindPaletteItem ? [sessionFindPaletteItem] : []), sessionSearchPaletteItem, ...terminalPaletteItems, developerModePaletteItem, diagnosticsCopyPaletteItem, diagnosticsExportPaletteItem, nextSessionTabPaletteItem, prevSessionTabPaletteItem, reloadConfigPaletteItem]}
      listAgents={listAgents}
      selectedAgent={selectedAgent}
      onSelectAgent={setSelectedAgent}
    />
    <SessionSearchDialog
      open={sessionSearchOpen}
      onClose={() => setSessionSearchOpen(false)}
      sessions={paletteSessionOptions}
      fetchMessages={sessionSearchFetcher}
      onOpenSession={(workspaceId, sessionId) => navigateToWorkspaceSession(workspaceId, sessionId)}
    />
    <ModelPickerModal
      open={modelPicker.open}
      options={modelPicker.options}
      organizationModelsEmpty={organizationModelsEmpty}
      organizationModelsSettingsUrl={organizationModelsSettingsUrl}

      query={modelPicker.query}
      setQuery={modelPicker.setQuery}
      subtitle={
        resolveModelAvailability(
          (modelPickerSessionId ? getSessionModelSelection(modelPickerSessionId)?.model : null)
            ?? local.prefs.defaultModel
            ?? null,
        ).status === "unavailable"
          ? MODEL_PICKER_UNAVAILABLE_SUBTITLE
          : undefined
      }
      target="default"
      current={
        (modelPickerSessionId ? getSessionModelSelection(modelPickerSessionId)?.model : null)
          ?? local.prefs.defaultModel
          ?? ({ providerID: "", modelID: "" } satisfies ModelRef)
      }
      onSelect={(next: ModelRef) => {
        applySessionRouteModelSelection(next, modelPickerSessionId);
        setModelPickerSessionId(null);
        modelPicker.setOpen(false);
      }}
      disabledProviders={disabledProviderIds}
      onBehaviorChange={() => {}}
      onToggleProvider={async (providerId, enable) => {
        if (!opencodeClient) return;
        try {
          const config = unwrap(await opencodeClient.config.get());
          const current = disabledProvidersFromConfig(config);
          const next = enable
            ? current.filter((id: string) => id !== providerId)
            : [...current, providerId];
          const result = await updateManagedDisabledProviders({
            opencodeClient,
            openworkClient: selectedWorkspaceEndpoint?.client ?? null,
            workspaceId: selectedWorkspaceEndpoint?.workspaceId ?? null,
            workspaceType: selectedWorkspace?.workspaceType ?? "local",
            disabledProviders: next,
            currentConfig: config,
            markReloadRequired: () => {
              reloadCoordinator.markReloadRequired("config", {
                type: "config",
                name: "runtime-opencode-config.json",
                action: "updated",
              });
            },
          });
          setDisabledProviderIds(result.disabledProviders);
        } catch {}
      }}
      onOpenSettings={() => {
        modelPicker.setOpen(false);
        handleOpenSettings("/settings/general");
      }}
      onClose={() => { modelPicker.setOpen(false); modelPicker.setRecentProviderIds(new Set()); setModelPickerSessionId(null); }}
      openWorkModelsEntitled={openWorkModelsEntitled}
      openWorkModelsSyncing={openWorkModelsSyncing}
      onRefreshOrganizationModels={refreshOrganizationModelAccess}
      restrictToCloud={restrictToCloudProviders}
    />
    </WorkspaceProvider>
  );
}
