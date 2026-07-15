/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "@/components/ui/sonner";
import type {
  AgentPartInput,
  FilePartInput,
  ProviderListResponse,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import { captureAnalyticsEvent, markTaskRunStart } from "@/app/lib/analytics";
import { trackSessionActive, trackTaskStarted } from "@/app/lib/den-telemetry";
import { buildDiagnosticsBundleJson } from "@/app/lib/diagnostics-bundle";
import { downloadTextAsFile } from "@/app/lib/download";
import { createClient, unwrap } from "@/app/lib/opencode";
import { abortSessionSafe, forkSession, listCommands, revertSession, setSessionArchived, shellInSession } from "@/app/lib/opencode-session";
import { useSessionManagementStore as sessionManagementStore } from "@/react-app/domains/session/sidebar/session-management-store";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  readOpenworkServerSettings,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "@/app/lib/openwork-server";
import {
  resolveWorkspaceEndpoint,
  workspaceServerId,
  type ResolvedWorkspaceEndpoint,
} from "@/app/lib/workspace-endpoint";
import { buildOpenworkEnvRuntimeKey } from "@/app/lib/openwork-env-runtime";
import {
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
  ComposerDraft,
  ComposerPart,
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
import { SessionPage, type OpenSessionTab } from "@/react-app/domains/session/chat/session-page";
import { isDesktopProviderBlocked, DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID } from "@/app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "@/react-app/domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "@/react-app/domains/cloud/restriction-notice-provider";
import { ReactSessionRuntime } from "@/react-app/domains/session/sync/runtime-sync";
import { useSessionActivityStore } from "@/react-app/domains/session/status/session-activity-store";
import { buildOpenworkEnvSystemContext } from "@/react-app/domains/session/sync/env-context";
import {
  applySessionRevert,
} from "@/react-app/domains/session/sync/session-sync";
import { firstLineLocalFileParts, joinWorkspaceRelativePath, toFileUrl } from "@/react-app/domains/session/sync/prompt-file-parts";
import { composerAttachmentsToWorkspaceFileParts } from "@/react-app/domains/session/sync/attachment-file-part";
import { useSessionInteractions } from "@/react-app/domains/session/sync/use-session-interactions";
import { useModelBehavior } from "@/react-app/domains/session/surface/use-model-behavior";
import { useSessionFindStore } from "@/react-app/domains/session/surface/find-store";
import { useModelPicker } from "@/react-app/domains/session/modals/use-model-picker";
import { appMentionInstruction } from "@/react-app/domains/session/surface/composer/app-mentions";
import { CreateRemoteWorkspaceModal } from "@/react-app/domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "@/react-app/domains/workspace/create-workspace-modal";
import type { CreateWorkspaceOptions } from "@/react-app/domains/workspace/types";
import { useSessionProviderAuth } from "@/react-app/domains/connections/provider-auth/use-session-provider-auth";
import { useMcpConnectedCount } from "@/react-app/domains/connections/use-mcp-connected-count";
import { useSessionMcpMaintenance } from "@/react-app/domains/connections/use-session-mcp-maintenance";
import { useCloudMcpSubmitReadiness } from "@/react-app/domains/connections/use-cloud-mcp-submit-readiness";
import type { CloudMcpSubmissionResult } from "@/react-app/domains/connections/cloud-mcp-submit-readiness";
import { useRemoteAccessRestart } from "@/react-app/domains/workspace/remote-access-restart";
import { RenameWorkspaceModal } from "@/react-app/domains/workspace/rename-workspace-modal";
import { useRemoteWorkspaceConnectionEditor } from "@/react-app/domains/workspace/use-remote-workspace-connection-editor";
import { useDenAuth } from "@/react-app/domains/cloud/den-auth-provider";
import { OpenWorkModelsStartupDialog } from "@/react-app/domains/cloud/openwork-models-startup-dialog";
import {
  OPENWORK_MODEL_PREVIEWS,
  getOpenWorkModelsActionUrl,
  hideOpenWorkModelsPromo,
  markOpenWorkModelsStartupPromoShown,
} from "@/react-app/domains/cloud/openwork-models-promo";
import { FirstRunLoader } from "@/react-app/domains/onboarding/first-run-loader";
import { ProviderSelectionStep } from "@/react-app/domains/onboarding/provider-selection-step";
import { useOpenWorkModelsStartupPromo } from "@/react-app/domains/cloud/use-openwork-models-startup-promo";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "@/react-app/domains/workspace/remote-workspace-diagnostics";
import { useShareWorkspaceState } from "@/react-app/domains/workspace/share-workspace-state";
import { ModelPickerModal, MODEL_PICKER_UNAVAILABLE_SUBTITLE } from "@/react-app/domains/session/modals/model-picker-modal";
import { CommandPalette, type PaletteItem, type SessionGroupOption } from "./command-palette";
import { buildCommandPaletteSessions } from "./command-palette-sessions";
import { SessionSearchDialog } from "./session-search-dialog";
import type { SessionMessageFetcher } from "@/react-app/domains/session/search/session-search";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readActiveWorkspaceId,
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
import { saveSessionDraft } from "@/react-app/domains/session/sync/draft-store";
import { useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { useReactRenderWatchdog } from "./react-render-watchdog";

import { readDenSettings } from "@/app/lib/den";
import { denSessionUpdatedEvent } from "@/app/lib/den-session-events";

import { filterProviderList } from "@/app/utils/providers";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import { useReloadCoordinator } from "./reload-coordinator";
import { useShellConfig } from "./shell-config";
import { useShellShortcuts } from "./use-shell-shortcuts";
import { useEngineReload } from "./use-engine-reload";
import { useSessionGroupSync } from "./use-session-group-sync";
import { useWorkspaceRouteState } from "./use-workspace-route-state";
import { getReactQueryClient } from "@/react-app/infra/query-client";
import { useSessionControlActions } from "@/react-app/domains/session/control/session-control-actions";
import { legacySessionRoute, workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";
import { WorkspaceProvider } from "./workspace-provider";
import type { OpenTarget } from "@/react-app/domains/session/artifacts/open-target";
import { SettingsSurface } from "./settings-route";
import {
  ensureProviderListQuery,
  getConnectedProviderItems,
  isModelAvailableInConnectedProviders,
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

// All workspace-scoped server URLs/clients/tokens come from
// `resolveWorkspaceEndpoint` in apps/app/src/app/lib/workspace-endpoint.ts.
// Don't compose `<baseUrl>/workspace/<id>` here.

async function draftToParts(
  draft: ComposerDraft,
  workspaceRoot: string,
  sessionId: string,
  endpoint: ResolvedWorkspaceEndpoint | null,
) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return trimmed;
    if (!root) return "";
    return joinWorkspaceRelativePath(root, trimmed);
  };

  const filenameFromPath = (path: string) => {
    const normalized = path.replace(/\\/g, "/");
    const segments = normalized.split("/").filter(Boolean);
    return segments[segments.length - 1] ?? "file";
  };

  for (const part of draft.parts) {
    if (part.type === "text") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "paste") {
      parts.push({ type: "text", text: part.text });
      continue;
    }
    if (part.type === "agent") {
      parts.push({ type: "agent", name: part.name });
      continue;
    }
    if (part.type === "skill") {
      parts.push({ type: "text", text: `Load [skill ${part.name}] and follow its instructions.` });
      continue;
    }
    if (part.type === "app") {
      parts.push({ type: "text", text: appMentionInstruction(part.name) });
      continue;
    }
    if (part.type === "file") {
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: toFileUrl(absolute),
        filename: filenameFromPath(part.path),
      });
    }
  }

  parts.push(...firstLineLocalFileParts(draft.resolvedText ?? draft.text, root));

  if (draft.attachments.length > 0) {
    if (!endpoint) {
      throw new Error("Workspace endpoint is unavailable; attachments could not be copied for tool access.");
    }
    parts.push(...(await composerAttachmentsToWorkspaceFileParts({
      attachments: draft.attachments,
      endpoint,
      sessionId,
      workspaceRoot: root,
    })));
  }

  return parts;
}

// Module-scoped so the first-run loader survives route remounts during boot
// (component state would reset and flash the underlying page). Reset only on
// app relaunch, matching BOOT_STARTED in desktop-runtime-boot.ts.
let firstRunLoaderPhase: "unarmed" | "armed" | "done" = "unarmed";

export function SessionRoute() {
  const navigate = useNavigate();
  const platform = usePlatform();
  const denAuth = useDenAuth();
  const { config: shellConfig } = useShellConfig();
  const local = useLocal();
  const reloadCoordinator = useReloadCoordinator();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const [openworkServerHostInfoState, setOpenworkServerHostInfoState] = useState<OpenworkServerInfo | null>(null);
  const [openworkServerSettingsVersion, setOpenworkServerSettingsVersion] = useState(0);
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
    refreshInFlightRef,
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
    loadWorkspaceSessionsInBackground,
    rememberPendingCreatedSession,
    handleRuntimeSessionUpdated,
    handleRemoteWorkspaceConnectionSaved,
    runRemoteWorkspaceConnectionCheck,
  } = useWorkspaceRouteState({
    onServerSettingsChanged: () => setOpenworkServerSettingsVersion((value) => value + 1),
    onHostInfo: setOpenworkServerHostInfoState,
  });
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
  // Agent-screen-first onboarding: a one-shot provider selection intercepting
  // the first send (the first-run default workspace is created further down).
  const [providerStepOpen, setProviderStepOpen] = useState(false);
  const pendingProviderDraftRef = useRef<{ draft: ComposerDraft; sessionId: string } | null>(null);
  const providerStepResendRef = useRef(false);
  const firstRunSessionRef = useRef(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [developerMode, setDeveloperMode] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem("openwork.developerMode") === "1";
  });
  const [paletteAccessibleTargets, setPaletteAccessibleTargets] = useState<OpenTarget[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerDefaults, setProviderDefaults] = useState<Record<string, string>>({});
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  // Exclude the built-in OpenCode Zen provider from the "user" count so the
  // onboarding CTA ("Connect a model") only considers user-added providers.
  const userProviderConnectedIds = useMemo(
    () => providerConnectedIds.filter((id) => id !== DESKTOP_RESTRICTION_OPENCODE_PROVIDER_ID),
    [providerConnectedIds],
  );
  const [disabledProviderIds, setDisabledProviderIds] = useState<string[]>([]);
  // Bump to re-filter provider list when den session changes (sign-in/out)
  const [denSessionVersion, setDenSessionVersion] = useState(0);
  useEffect(() => {
    const handler = () => setDenSessionVersion((v) => v + 1);
    window.addEventListener(denSessionUpdatedEvent, handler);
    return () => window.removeEventListener(denSessionUpdatedEvent, handler);
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
  const modelPicker = useModelPicker({
    client: opencodeClient,
    baseUrl: opencodeBaseUrl,
    workspaceRoot: selectedWorkspaceRoot,
  });
  const selectedModelUnavailable = Boolean(
    local.prefs.defaultModel &&
      (
        isDesktopProviderBlocked({
          providerId: local.prefs.defaultModel.providerID,
          checkRestriction: checkDesktopRestriction,
        }) ||
        (
          checkDesktopRestriction({ restriction: "allowCustomProviders" }) &&
          !providerConnectedIds.some(
            (providerId) => providerId.trim() === local.prefs.defaultModel?.providerID.trim(),
          )
        ) ||
        (
          providerListQuery.data &&
          !isModelAvailableInConnectedProviders(providerListQuery.data, local.prefs.defaultModel)
        )
      ),
  );
  const selectedModelUnavailableKey = selectedModelUnavailable && local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}:${local.prefs.defaultModel.modelID}`
    : null;
  const autoOpenedUnavailableModelRef = useRef<string | null>(null);

  useEffect(() => {
    if (!selectedModelUnavailableKey) {
      autoOpenedUnavailableModelRef.current = null;
      return;
    }
    if (autoOpenedUnavailableModelRef.current === selectedModelUnavailableKey) return;

    autoOpenedUnavailableModelRef.current = selectedModelUnavailableKey;
    modelPicker.setQuery("");
    modelPicker.setRecentProviderIds(new Set());
    modelPicker.setCompactOpen(false);
    modelPicker.setOpen(true);
  }, [modelPicker.setCompactOpen, modelPicker.setOpen, modelPicker.setQuery, modelPicker.setRecentProviderIds, selectedModelUnavailableKey]);

  const hasUsableModel = Boolean(local.prefs.defaultModel && !selectedModelUnavailable);
  const canCreateTask = Boolean(
    opencodeClient && selectedWorkspaceId && !loading && !selectedWorkspaceError && !selectedModelUnavailable,
  );

  const openWorkModelsPromo = useOpenWorkModelsStartupPromo({
    clientReady: Boolean(opencodeClient),
    workspaceId: selectedWorkspaceId,
    providerConnectedIds,
    // First-run users get the OpenWork Models pitch from the provider
    // selection step on their first send, not a startup popup. Completing
    // the step marks the promo as shown, so it never auto-pops for them.
    suppressed: providerStepOpen || !local.prefs.providerStepCompleted,
  });

  const { store: sessionProviderAuthStore, snapshot: sessionProviderAuthSnapshot } =
    useSessionProviderAuth({
      opencodeClient,
      providers,
      providerDefaults,
      providerConnectedIds,
      disabledProviderIds,
      selectedWorkspace,
      selectedWorkspaceEndpoint,
      selectedWorkspaceRoot,
      selectedWorkspaceId,
      setProviders,
      setProviderDefaults,
      setProviderConnectedIds,
      setDisabledProviderIds,
    });
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
  const showPreparingStatus =
    effectiveLoading ||
    (!canCreateTask && !routeError && !selectedWorkspaceError);

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
      // When not signed in, filter out cloud-managed providers (lpr_*)
      // so stale entries from a previous session don't appear.
      const hasCloudAuth = !!readDenSettings().authToken?.trim();
      const isCloudProvider = (id: string) => /^lpr_/i.test(id);
      const all = hasCloudAuth
        ? ((value.all ?? []) as ProviderListItem[])
        : ((value.all ?? []) as ProviderListItem[]).filter(
            (p) => !isCloudProvider(p.id ?? ""),
          );
      const connected = hasCloudAuth
        ? (value.connected ?? [])
        : (value.connected ?? []).filter((id) => !isCloudProvider(id));
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
        ) as { disabled_providers?: string[] };
        disabledProviders = Array.isArray(config.disabled_providers)
          ? config.disabled_providers
          : [];
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
    return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
  }, [engineReloadVersion, opencodeClient]);

  const handleOpenSettings = useCallback((route = "/settings/general", workspaceId = sidebarActiveWorkspaceId) => {
    const sessionId = workspaceId === sidebarActiveWorkspaceId ? selectedSessionId : null;
    const tab = route.replace(/^\/settings\/?/, "").replace(/^\/+|\/+$/g, "") || "general";
    const target = workspaceId ? workspaceSettingsRoute(workspaceId, tab) : route;
    writeActiveWorkspaceId(workspaceId || null);
    navigate(target, { state: { workspaceId, sessionId } });
  }, [navigate, selectedSessionId, sidebarActiveWorkspaceId]);

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
      developerMode: false,
      modelLabel,
      onModelClick: () => {
        modelPicker.setQuery("");
        modelPicker.setOpen(true);
      },
      modelPickerOpen: modelPicker.compactOpen,
      modelUnavailable: selectedModelUnavailable,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      onModelPickerOpenChange: modelPicker.setCompactOpen,
      onModelChange: (model: ModelRef) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
        modelPicker.setCompactOpen(false);
      },
      providerConnectedCount: hasUsableModel ? 1 : providerConnectedIds.length,
      onOpenSettingsSection: (section: "commands" | "skills" | "mcps" | "plugins" | "providers") => {
        handleOpenSettings(section === "skills" ? "/settings/skills" : section === "mcps" ? "/settings/extensions/mcp" : section === "plugins" ? "/settings/extensions/plugins" : section === "providers" ? "/settings/ai" : "/settings/general");
      },
      onSendDraft: async (draft: ComposerDraft, sessionId: string): Promise<CloudMcpSubmissionResult> => {
        const targetSessionId = sessionId.trim() || selectedSessionId;
        if (!targetSessionId) return { outcome: "cancelled", reason: "context_changed" };
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!text && draft.attachments.length === 0) {
          return { outcome: "cancelled", reason: "context_changed" };
        }
        // One-shot provider selection on the first send whenever no user-added
        // provider is connected. The free default model being usable is the
        // normal case here, not a reason to skip the step.
        if (
          !providerStepResendRef.current &&
          !local.prefs.providerStepCompleted &&
          isDesktopRuntime() &&
          userProviderConnectedIds.length === 0 &&
          draft.mode !== "shell"
        ) {
          pendingProviderDraftRef.current = { draft, sessionId: targetSessionId };
          setProviderStepOpen(true);
          return { outcome: "accepted" };
        }
        if (selectedModelUnavailable) throw new Error("Selected model is unavailable. Choose another model before sending.");

        return submitWithCloudMcpReadiness({
          // Temporarily bypass the pre-send Cloud MCP gate: it blocks every
          // message, including tasks that do not use connected services.
          skipGate: true,
          send: async () => {
            captureAnalyticsEvent("task_message_sent", {
              mode: draft.mode ?? "prompt",
              is_command: Boolean(draft.command),
              attachment_count: draft.attachments.length,
              text_length: text.length,
              workspace_type: selectedWorkspace?.workspaceType ?? "unknown",
              provider_id: local.prefs.defaultModel?.providerID ?? null,
              model_id: local.prefs.defaultModel?.modelID ?? null,
            });
            markTaskRunStart(targetSessionId);
            // Den org adoption signals (auth-gated inside; no-op when signed out).
            // This remains inside the post-readiness send closure so a blocked
            // Cloud submission cannot create a run or report that one started.
            const projectDimension = readWorkspaceProjectDimension(selectedWorkspaceId);
            const telemetryDimensions = projectDimension
              ? [{
                  type: "project",
                  label: projectDimension.label,
                }]
              : undefined;
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
              model: local.prefs.defaultModel ?? undefined,
              agent: selectedAgent ?? undefined,
              ...(modelVariantValue ? { variant: modelVariantValue } : {}),
              ...(envSystemContext ? { system: envSystemContext } : {}),
            });
            if (result.error) {
              throw new Error(serializeSDKError(result.error));
            }
          },
        });
      },
      cloudMcpSubmissionState,
      onOpenConnect: () => navigate("/settings/connect"),
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
          await abortSessionSafe(opencodeClient, targetSessionId, selectedWorkspaceRoot || undefined);
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
    handleOpenSettings,
    hasUsableModel,
    handleApplyEnvironmentChanges,
    environmentRuntimeKey,
    local,
    userProviderConnectedIds,
    listAgents,
    listSlashCommands,
    modelBehaviorOptions,
    cloudMcpSubmissionState,
    modelLabel,
    modelVariantLabel,
    modelVariantValue,
    navigate,
    opencodeBaseUrl,
    opencodeClient,
    providerConnectedIds,
    selectedAgent,
    selectedSessionId,
    selectedModelUnavailable,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    submitWithCloudMcpReadiness,
    token,
  ]);

  // Latest surfaceProps for the provider-step resend below; the memoized
  // onSendDraft closure is otherwise unreachable from callbacks.
  const surfacePropsRef = useRef<typeof surfaceProps>(null);
  useEffect(() => {
    surfacePropsRef.current = surfaceProps;
  });

  const completeProviderStep = useCallback((action: "openwork-models" | "byok" | "skip") => {
    setProviderStepOpen(false);
    local.setPrefs((prev) => ({ ...prev, providerStepCompleted: true }));
    // The step IS the OpenWork Models pitch — never auto-pop the startup
    // promo on top of it afterwards.
    markOpenWorkModelsStartupPromoShown();
    if (action === "openwork-models") {
      platform.openLink(getOpenWorkModelsActionUrl(denAuth.isSignedIn, "sign-up"));
    } else if (action === "byok") {
      hideOpenWorkModelsPromo();
      void sessionProviderAuthStore.openProviderAuthModal({ returnFocusTarget: "composer" });
    }
    // ponytail: the held draft is resent immediately on the free model for
    // all three choices; a byok key applies from the next message onward.
    const pending = pendingProviderDraftRef.current;
    pendingProviderDraftRef.current = null;
    const send = surfacePropsRef.current?.onSendDraft;
    if (pending && send) {
      providerStepResendRef.current = true;
      void Promise.resolve(send(pending.draft, pending.sessionId))
        .catch((error) => setRouteError(describeRouteError(error)))
        .finally(() => {
          providerStepResendRef.current = false;
        });
    }
  }, [denAuth.isSignedIn, local, platform, sessionProviderAuthStore, setRouteError]);

  const handleOpenCreateWorkspace = useCallback(() => {
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


  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string): Promise<string | null> => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      !workspace ||
      loading ||
      retryingWorkspaceIds.includes(workspaceId)
    ) {
      return null;
    }
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
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
            refreshInFlightRef.current = false;
            void refreshRouteState();
          }, 1_000);
        }
      }
      return null;
    }
  }, [baseUrl, loading, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession, retryingWorkspaceIds, token, workspaces]);

  // Full-screen first-run loader. Armed once per app launch from the very
  // first render of a brand-new profile (no active-workspace memory yet) and
  // held through all boot-state churn AND route remounts — recomputing
  // visibility from volatile route state made it flicker, and a remount
  // would reset component state. It drops only when the first session is
  // selected, on error (retry toast must be reachable), when state settles
  // and this turns out not to be a first run, or after a safety timeout.
  const [firstRunLoaderActive, setFirstRunLoaderActive] = useState(() => {
    if (firstRunLoaderPhase === "unarmed") {
      firstRunLoaderPhase = isDesktopRuntime() && !readActiveWorkspaceId() ? "armed" : "done";
    }
    return firstRunLoaderPhase === "armed";
  });
  const dismissFirstRunLoader = useCallback(() => {
    firstRunLoaderPhase = "done";
    setFirstRunLoaderActive(false);
  }, []);
  useEffect(() => {
    if (!firstRunLoaderActive) return;
    // Safety cap only: a cold first engine boot measured 35–40s on a slow
    // Windows VM, so 30s cut the loader early and flashed the empty session
    // page. Errors and settled states still dismiss immediately below.
    const timeout = window.setTimeout(dismissFirstRunLoader, 120_000);
    return () => window.clearTimeout(timeout);
  }, [firstRunLoaderActive, dismissFirstRunLoader]);
  useEffect(() => {
    if (!firstRunLoaderActive) return;
    if (selectedSessionId) {
      dismissFirstRunLoader();
      return;
    }
    const workspaceError = selectedWorkspaceId ? errorsByWorkspaceId[selectedWorkspaceId] : null;
    if (routeError || selectedWorkspaceError || workspaceError) {
      dismissFirstRunLoader();
      return;
    }
    // State settled and this profile already has sessions or last-session
    // memory (not a first run): hand back to the normal UI. Skipped once the
    // auto-create below has latched — our own just-created session briefly
    // satisfies this before navigation lands.
    if (
      !loading &&
      !firstRunSessionRef.current &&
      selectedWorkspaceId &&
      ((sessionsByWorkspaceId[selectedWorkspaceId] ?? []).length > 0 ||
        Boolean(readLastSessionFor(selectedWorkspaceId)))
    ) {
      dismissFirstRunLoader();
    }
  }, [firstRunLoaderActive, dismissFirstRunLoader, selectedSessionId, routeError, selectedWorkspaceError, errorsByWorkspaceId, loading, selectedWorkspaceId, sessionsByWorkspaceId]);

  // Drop the user straight into a chat-ready session when they arrive at a
  // workspace they have never used (no sessions, no last-session memory),
  // instead of the "select or create a session" page. Retries on the next
  // state change until a session is actually created — the create call bails
  // silently while the workspace endpoint/token is still resolving at boot.
  useEffect(() => {
    if (!canCreateTask || !isDesktopRuntime()) return;
    if (selectedSessionId || firstRunSessionRef.current) return;
    if ((sessionsByWorkspaceId[selectedWorkspaceId] ?? []).length > 0) return;
    if (readLastSessionFor(selectedWorkspaceId)) return;
    firstRunSessionRef.current = true;
    void handleCreateTaskInWorkspace(selectedWorkspaceId).then((createdSessionId) => {
      if (!createdSessionId) firstRunSessionRef.current = false;
    });
  }, [canCreateTask, selectedSessionId, selectedWorkspaceId, sessionsByWorkspaceId, handleCreateTaskInWorkspace]);

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

  const {
    commandPaletteOpen,
    setCommandPaletteOpen,
    sessionSearchOpen,
    setSessionSearchOpen,
    terminalOpen,
    setTerminalOpen,
  } = useShellShortcuts({
    canCreateTask,
    workspaceId: selectedWorkspaceId,
    onCreateTask: (workspaceId: string) => void handleCreateTaskInWorkspace(workspaceId),
    onNextSessionTab: goToNextSessionTab,
    onPrevSessionTab: goToPrevSessionTab,
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
    modelPicker.setOpen(true);
  }, []);

  useSessionControlActions({
    workspaces,
    sessionsByWorkspaceId,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    selectedSessionId,
    canCreateTask,
    openworkClient: client,
    opencodeClient,
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
      description: "Dev-only eval hook that selects a missing model and returns an available model to recover with.",
      sideEffect: "mutation",
      disabled: !opencodeClient,
      execute: async () => {
        if (!opencodeClient) return { ok: false, error: "OpenCode client is not connected." };

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

        return {
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

  const commandPaletteControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "command_palette.open",
    label: "Open the command palette",
    description: "Open the in-app command palette so the next choice is visible.",
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
      if (checkDesktopRestriction({ restriction: "allowCustomProviders" })) {
        return { ok: false, error: "Custom providers are disabled by your organization." };
      }
      const providerId = typeof rawArgs === "object" && rawArgs !== null
        ? (rawArgs as Record<string, unknown>).providerId
        : undefined;
      const preferred = typeof providerId === "string" ? providerId.trim() : undefined;
      await sessionProviderAuthStore.openProviderAuthModal(
        preferred ? { preferredProviderId: preferred } : undefined,
      );
      return { ok: true, opened: "provider_auth_modal", preferredProviderId: preferred ?? null };
    },
  }), [checkDesktopRestriction, sessionProviderAuthStore]);
  useControlAction(addProviderControlAction);

  const paletteSessionOptions = useMemo(
    () => buildCommandPaletteSessions(workspaces, sessionsByWorkspaceId, selectedWorkspaceId),
    [sessionsByWorkspaceId, selectedWorkspaceId, workspaces],
  );

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
    return async (workspaceId: string, sessionId: string) =>
      (await client.getSessionMessages(workspaceId, sessionId, { limit: 400 })).items;
  }, [client]);

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

  const terminalPaletteItems = useMemo<PaletteItem[]>(() => [
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
  ], [terminalOpen]);

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
      try {
        await setSessionArchived(
          opencodeClient,
          sessionId,
          archived,
          selectedWorkspaceRoot || undefined,
        );
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
    [opencodeClient, refreshRouteState, selectedWorkspaceRoot],
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
      // Completing the classic flow also counts as the provider step so the
      // OpenWork Models startup promo is not suppressed forever (its
      // `suppressed` input keys off providerStepCompleted).
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true, providerStepCompleted: true }));
      await refreshRouteState();
      if (targetWorkspaceId) {
        const workspacePath = targetWorkspace?.path?.trim() || folder;
        // Best-effort first task creation (mirrors the old welcome flow) — a
        // failure here must not surface as a failed workspace creation.
        const session = createdOnServer && sessionBaseUrl && sessionToken
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
      // Completing the classic flow also counts as the provider step so the
      // OpenWork Models startup promo is not suppressed forever (its
      // `suppressed` input keys off providerStepCompleted).
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true, providerStepCompleted: true }));
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
        onSessionUpdated={handleRuntimeSessionUpdated}
      />
    ) : null}
    <SessionPage
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
      headerStatus={canCreateTask ? t("status.connected") : t("session.loading_detail")}
      busyHint={effectiveLoading ? t("session.loading_detail") : null}
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
      onOpenProviderAuth={() => sessionProviderAuthStore.openProviderAuthModal({ returnFocusTarget: "composer" })}
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
        onConnectCloudProvider: async (cloudProviderId) => {
          const result = await sessionProviderAuthStore.connectCloudProvider(cloudProviderId);
          modelPicker.setRecentProviderIds(new Set([cloudProviderId]));
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
        onSelectWorkspace: async (workspaceId) => {
          if (workspaceId === selectedWorkspaceId) return true;
          setLegacySelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          const workspace = workspaces.find((item) => item.id === workspaceId);
          if (client && workspace && !sessionsByWorkspaceId[workspaceId]?.length) {
            setRetryingWorkspaceIds((current) => Array.from(new Set([...current, workspaceId])));
            void loadWorkspaceSessionsInBackground([workspace]);
          }
          // Fire Tauri updates but don't await them — they're bookkeeping and
          // awaiting 2 IPC roundtrips on every click used to stall rapid
          // workspace switches behind a queue.
          if (isDesktopRuntime()) {
            void workspaceSetSelected(workspaceId).catch(() => undefined);
            void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
          }
          // Tell the OpenWork server this workspace is now active so it can
          // emit a config reload event that the OpenCode engine picks up.
          // Without this, the permissions from opencode.jsonc are never
          // applied on the workspace the user is already on at launch. See
          // issue #870.
          if (workspaceId) {
            const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
            const endpoint = endpointForWorkspace(workspace);
            if (endpoint) {
              void endpoint.client.activateWorkspace(endpoint.workspaceId, { persist: true }).catch(() => undefined);
            }
          }
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
        onCreateTaskWithPrompt: (workspaceId, prompt) => {
          void (async () => {
            const workspace = workspaces.find((item) => item.id === workspaceId);
            if (!workspace) return;
            const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
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
              saveSessionDraft(workspaceId, session.id, { text: prompt, mode: "prompt" });
              writeActiveWorkspaceId(workspaceId || null);
              writeLastSessionFor(workspaceId, session.id);
              rememberPendingCreatedSession(workspaceId, session.id);
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
              await endpoint.client.deleteSession(endpoint.workspaceId, sessionId);
              if (selectedSessionId === sessionId) {
                navigateToWorkspaceSession(selectedWorkspaceId);
              }
              await refreshRouteState();
            }
          : undefined
      }
      onArchiveSession={opencodeClient ? handleArchiveSession : undefined}
      statusBar={{
        loading: showPreparingStatus,
        reloadBusy: reloadCoordinator.reloadBusy,
        reloadError: reloadCoordinator.reloadError,
        openWorkConnectState: sessionMcpMaintenance,
      }}
      notFoundMessage={routeNotFoundMessage}
      onAccessibleTargetsChange={setPaletteAccessibleTargets}
    />
    <OpenWorkModelsStartupDialog
      open={openWorkModelsPromo.open}
      isSignedIn={denAuth.isSignedIn}
      models={OPENWORK_MODEL_PREVIEWS}
      onSubscribe={openWorkModelsPromo.subscribe}
      onContinueWithout={openWorkModelsPromo.continueWithout}
    />
    {firstRunLoaderActive ? <FirstRunLoader /> : null}
    {providerStepOpen ? (
      <ProviderSelectionStep
        onOpenWorkModels={() => completeProviderStep("openwork-models")}
        onBringYourOwn={() => completeProviderStep("byok")}
        onSkip={() => completeProviderStep("skip")}
      />
    ) : null}
    <CreateWorkspaceModal
      open={createWorkspaceOpen}
      onClose={() => {
        setCreateWorkspaceOpen(false);
        setCreateWorkspaceError(null);
      }}
      onConfirm={handleCreateWorkspace}
      onConfirmRemote={handleCreateRemoteWorkspace}
      onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
      submitting={createWorkspaceBusy}
      localError={createWorkspaceError}
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
      onOpenSettings={(route) => handleOpenSettings(route ?? "/settings/general")}
      onOpenModelPicker={() => {
        modelPicker.setQuery("");
        modelPicker.setRecentProviderIds(new Set());
        window.requestAnimationFrame(() => modelPicker.setOpen(true));
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

      query={modelPicker.query}
      setQuery={modelPicker.setQuery}
      subtitle={selectedModelUnavailable ? MODEL_PICKER_UNAVAILABLE_SUBTITLE : undefined}
      target="default"
      current={local.prefs.defaultModel ?? ({ providerID: "", modelID: "" } satisfies ModelRef)}
      onSelect={(next: ModelRef) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: next,
          modelVariant: previous.defaultModel?.providerID === next.providerID && previous.defaultModel.modelID === next.modelID
            ? previous.modelVariant
            : null,
        }));
        modelPicker.setOpen(false);
        focusPromptSoon();
      }}
      disabledProviders={disabledProviderIds}
      onBehaviorChange={() => {}}
      onToggleProvider={async (providerId, enable) => {
        if (!opencodeClient) return;
        try {
          const config = unwrap(await opencodeClient.config.get()) as { disabled_providers?: string[] };
          const current = Array.isArray(config.disabled_providers) ? config.disabled_providers : [];
          const next = enable
            ? current.filter((id: string) => id !== providerId)
            : [...current, providerId];
          await opencodeClient.config.update({ config: { ...config, disabled_providers: next } });
          setDisabledProviderIds(next);
        } catch {}
      }}
      onOpenSettings={() => {
        modelPicker.setOpen(false);
        handleOpenSettings("/settings/general");
      }}
      onClose={() => { modelPicker.setOpen(false); modelPicker.setRecentProviderIds(new Set()); }}
    />
    </WorkspaceProvider>
  );
}
