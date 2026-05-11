/** @jsxImportSource react */
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import type {
  AgentPartInput,
  ConfigProvidersResponse,
  FilePartInput,
  ProviderListResponse,
  TextPartInput,
} from "@opencode-ai/sdk/v2/client";

import { createClient, unwrap } from "../../app/lib/opencode";
import { listCommands, shellInSession } from "../../app/lib/opencode-session";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  readOpenworkServerSettings,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";
import {
  resolveWorkspaceEndpoint,
  type ResolvedWorkspaceEndpoint,
} from "../../app/lib/workspace-endpoint";
import { buildOpenworkEnvRuntimeKey } from "../../app/lib/openwork-env-runtime";
import {
  engineInfo,
  revealDesktopItemInDir,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceExportConfig,
  workspaceForget,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  workspaceUpdateDisplayName,
  type EngineInfo,
  type OpenworkServerInfo,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/desktop";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  ModelOption,
  ModelRef,
  PendingPermission,
  SlashCommandOption,
  TodoItem,
  WorkspacePreset,
  WorkspaceConnectionState,
  ProviderListItem,
  WorkspaceSessionGroup,
} from "../../app/types";
import { buildFeedbackUrl } from "../../app/lib/feedback";
import {
  getWorkspaceTaskLoadErrorDisplay,
  isDesktopRuntime,
  isSandboxWorkspace,
  normalizeDirectoryPath,
  safeStringify,
} from "../../app/utils";
import { t } from "../../i18n";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { SessionPage } from "../domains/session/chat/session-page";
import { isDesktopProviderBlocked } from "../../app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "../domains/cloud/restriction-notice-provider";
import { ReactSessionRuntime } from "../domains/session/sync/runtime-sync";
import { buildOpenworkEnvSystemContext } from "../domains/session/sync/env-context";
import {
  permissionKey as reactPermissionKey,
  seedPermissionState,
} from "../domains/session/sync/session-sync";
import { CreateRemoteWorkspaceModal } from "../domains/workspace/create-remote-workspace-modal";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { useRemoteAccessRestart } from "../domains/workspace/remote-access-restart";
import { RenameWorkspaceModal } from "../domains/workspace/rename-workspace-modal";
import { useRemoteWorkspaceConnectionEditor } from "../domains/workspace/use-remote-workspace-connection-editor";
import {
  diagnoseRemoteWorkspaceTaskLoadFailure,
  getRemoteWorkspaceConnectionKey,
  testRemoteWorkspaceConnection,
} from "../domains/workspace/remote-workspace-diagnostics";
import { useShareWorkspaceState } from "../domains/workspace/share-workspace-state";
import { ModelPickerModal } from "../domains/session/modals/model-picker-modal";
import { CommandPalette, type SessionOption as PaletteSessionOption } from "./command-palette";
import { getDisplaySessionTitle } from "../../app/lib/session-title";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readActiveWorkspaceId,
  readLastSessionFor,
  readWorkspaceOrderIds,
  writeActiveWorkspaceId,
  writeLastSessionFor,
  writeWorkspaceOrderIds,
} from "./session-memory";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "./app-inspector";
import { saveSessionDraft } from "../domains/session/sync/draft-store";
import { useControlAction, type OpenworkControlAction } from "./control/control-provider";
import { useReactRenderWatchdog } from "./react-render-watchdog";
import { getModelBehaviorSummary } from "../../app/lib/model-behavior";
import { filterProviderList, mapConfigProvidersToList } from "../../app/utils/providers";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";
import { resolveOpenworkConnection } from "./openwork-connection";
import { useReloadCoordinator } from "./reload-coordinator";
import { getReactQueryClient } from "../infra/query-client";
import { useStatusToasts } from "../domains/shell-feedback/status-toasts";
import { useSessionControlActions } from "../domains/session/control/session-control-actions";
import { legacySessionRoute, workspaceSessionRoute, workspaceSettingsRoute } from "./workspace-routes";
import { WorkspaceProvider } from "./workspace-provider";

type RouteWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved: string;
};

function mapDesktopWorkspace(workspace: WorkspaceInfo): RouteWorkspace {
  return {
    ...workspace,
    displayNameResolved:
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback"),
  };
}

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

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

function isTransientStartupError(message: string | null | undefined) {
  const value = (message ?? "").toLowerCase();
  return (
    value.includes("timed out") ||
    value.includes("failed to fetch") ||
    value.includes("connection") ||
    value.includes("not ready")
  );
}

function workspaceLabel(workspace: OpenworkWorkspaceInfo) {
  return (
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("session.workspace_fallback")
  );
}

function describeRouteError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
}

function describeWorkspaceCreateError(error: unknown) {
  const message = describeRouteError(error);
  const lower = message.toLowerCase();
  if (
    lower.includes("operation timed out") ||
    lower.includes("os error 60") ||
    lower.includes("etimedout")
  ) {
    return `${message}\n\nOpenWork could not read the workspace config before the filesystem timed out. This often happens when the folder is still syncing from iCloud Drive or another remote folder. Wait for the folder to finish downloading, move the workspace to a local folder, or try again.`;
  }
  return message;
}

function focusPromptSoon() {
  if (typeof window === "undefined") return;
  const focus = () => window.dispatchEvent(new Event("openwork:focusPrompt"));
  [0, 80, 240, 600].forEach((delay) => window.setTimeout(focus, delay));
}

const emptyPendingPermissions: PendingPermission[] = [];
const emptyModelBehaviorOptions: { value: string | null; label: string }[] = [];

function useQueryCacheState<T>(queryKey: readonly unknown[] | null, fallback: T): T {
  const queryClient = getReactQueryClient();
  return useSyncExternalStore(
    (callback) => (queryKey ? queryClient.getQueryCache().subscribe(callback) : () => {}),
    () => (queryKey ? queryClient.getQueryData<T>(queryKey) ?? fallback : fallback),
    () => fallback,
  );
}

function mergeRouteWorkspaces(
  serverWorkspaces: OpenworkWorkspaceInfo[],
  desktopWorkspaces: RouteWorkspace[],
): RouteWorkspace[] {
  const desktopById = new Map(desktopWorkspaces.map((workspace) => [workspace.id, workspace]));
  const desktopByPath = new Map(
    desktopWorkspaces.flatMap((workspace) => {
      const path = normalizeDirectoryPath(workspace.path ?? "");
      return path ? [[path, workspace] as const] : [];
    }),
  );

  // If a server workspace's id matches a desktop workspace marked as remote,
  // skip the server's view entirely. The local OpenWork server may have stale
  // registrations from earlier (buggy) activate calls that show up here as
  // `workspaceType: "local"`, which would otherwise clobber the desktop's
  // remote routing fields and send workspace-scoped requests back to the
  // local server.
  const remoteDesktopIds = new Set(
    desktopWorkspaces.flatMap((workspace) => workspace.workspaceType === "remote" ? [workspace.id] : []),
  );
  const filteredServer = serverWorkspaces.filter((workspace) => !remoteDesktopIds.has(workspace.id));

  const mergedServer = filteredServer.map((workspace) => {
    const match =
      desktopById.get(workspace.id) ??
      desktopByPath.get(normalizeDirectoryPath(workspace.path ?? ""));
    // For local workspaces, prefer the server's view (which knows things like
    // `path` and per-workspace runtime fields) and only fall back to the
    // desktop's display name when the server doesn't provide one.
    const merged = match
      ? {
          ...workspace,
          displayName: workspace.displayName?.trim()
            ? workspace.displayName
            : match.displayName,
          name: match.name?.trim() ? match.name : workspace.name,
        }
      : workspace;
    return {
      ...merged,
      displayNameResolved: workspaceLabel(merged),
    };
  });

  const mergedIds = new Set(mergedServer.map((workspace) => workspace.id));
  const mergedPaths = new Set(
    mergedServer.flatMap((workspace) => {
      const path = normalizeDirectoryPath(workspace.path ?? "");
      return path ? [path] : [];
    }),
  );

  const missingDesktop = desktopWorkspaces.filter((workspace) => {
    if (mergedIds.has(workspace.id)) return false;
    const normalizedPath = normalizeDirectoryPath(workspace.path ?? "");
    if (normalizedPath && mergedPaths.has(normalizedPath)) return false;
    return true;
  });

  return [...mergedServer, ...missingDesktop];
}

function orderRouteWorkspaces(workspaces: RouteWorkspace[], orderIds: string[]): RouteWorkspace[] {
  if (orderIds.length === 0) return workspaces;

  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const ordered: RouteWorkspace[] = [];
  const usedIds = new Set<string>();

  for (const id of orderIds) {
    const workspace = workspaceById.get(id);
    if (!workspace || usedIds.has(id)) continue;
    ordered.push(workspace);
    usedIds.add(id);
  }

  for (const workspace of workspaces) {
    if (usedIds.has(workspace.id)) continue;
    ordered.push(workspace);
  }

  return ordered;
}

function toSessionGroups(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, any[]>,
  errorsByWorkspaceId: Record<string, string | null>,
  loadingWorkspaceIds: Set<string>,
): WorkspaceSessionGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    sessions: (sessionsByWorkspaceId[workspace.id] ?? []) as WorkspaceSessionGroup["sessions"],
    status: loadingWorkspaceIds.has(workspace.id)
      ? "loading"
      : errorsByWorkspaceId[workspace.id]
        ? "error"
        : "ready",
    error: errorsByWorkspaceId[workspace.id],
  }));
}

// All workspace-scoped server URLs/clients/tokens come from
// `resolveWorkspaceEndpoint` in apps/app/src/app/lib/workspace-endpoint.ts.
// Don't compose `<baseUrl>/workspace/<id>` here.

function isActiveSessionStatus(status: unknown) {
  return status === "running" || status === "retry" || status === "busy";
}

function getSessionStatus(session: any) {
  return session?.status ?? session?.state ?? session?.runStatus ?? null;
}

async function fileToDataUrl(file: File) {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Failed to read attachment: ${file.name}`));
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.readAsDataURL(file);
  });
}

async function draftToParts(draft: ComposerDraft, workspaceRoot: string) {
  const parts: Array<TextPartInput | FilePartInput | AgentPartInput> = [];
  const root = workspaceRoot.trim();

  const toAbsolutePath = (path: string) => {
    const trimmed = path.trim();
    if (!trimmed) return "";
    if (trimmed.startsWith("/")) return trimmed;
    if (/^[a-zA-Z]:\\/.test(trimmed)) return trimmed;
    if (!root) return "";
    return `${root}/${trimmed}`.replace(/\/\/+/g, "/");
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
    if (part.type === "file") {
      const absolute = toAbsolutePath(part.path);
      if (!absolute) continue;
      parts.push({
        type: "file",
        mime: "text/plain",
        url: `file://${absolute}`,
        filename: filenameFromPath(part.path),
      });
    }
  }

  parts.push(
    ...(await Promise.all(
      draft.attachments.map(async (attachment) => ({
        type: "file" as const,
        url: await fileToDataUrl(attachment.file),
        filename: attachment.name,
        mime: attachment.mimeType,
      })),
    )),
  );

  return parts;
}

export function SessionRoute() {
  const navigate = useNavigate();
  const platform = usePlatform();
  const local = useLocal();
  const reloadCoordinator = useReloadCoordinator();
  const { showToast } = useStatusToasts();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const params = useParams<{ workspaceId?: string; sessionId?: string }>();
  const routeWorkspaceId = params.workspaceId?.trim() || "";
  const selectedSessionId = params.sessionId?.trim() || null;
  const navigateToWorkspaceSession = useCallback((workspaceId: string, sessionId?: string | null, options?: { replace?: boolean }) => {
    const id = workspaceId.trim();
    if (!id) {
      navigate(legacySessionRoute(sessionId), options);
      return;
    }
    navigate(workspaceSessionRoute(id, sessionId), options);
  }, [navigate]);

  const { markRouteReady: markBootRouteReady } = useBootState();
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<OpenworkServerClient | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [workspaceOrderIds, setWorkspaceOrderIds] = useState<string[]>(() => readWorkspaceOrderIds());
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, any[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [workspaceConnectionOverrides, setWorkspaceConnectionOverrides] = useState<Record<string, WorkspaceConnectionState>>({});
  const [routeError, setRouteError] = useState<string | null>(null);
  const [legacySelectedWorkspaceId, setLegacySelectedWorkspaceId] = useState<string>(() => readActiveWorkspaceId() ?? "");
  const selectedWorkspaceId = routeWorkspaceId || legacySelectedWorkspaceId;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? (selectedWorkspaceId ? null : workspaces[0] ?? null),
    [selectedWorkspaceId, workspaces],
  );
  // Workspace-scoped API calls (sessions, events, activate, opencode/*) must
  // hit the worker that owns the workspace, not the user's local server. The
  // single source of truth for that routing is `resolveWorkspaceEndpoint`.
  //
  // We read the latest local server's baseUrl/token through a ref so the
  // `endpointForWorkspace` callback stays permanently stable. Otherwise it
  // would change on every `setBaseUrl`/`setToken`, which used to cascade up
  // through `loadWorkspaceSessionsInBackground` and `refreshRouteState` and
  // produce a tight render-refresh-setWorkspaces loop.
  const localServerRef = useRef<{ baseUrl: string; token: string }>({ baseUrl: "", token: "" });
  useEffect(() => {
    localServerRef.current = { baseUrl, token };
  }, [baseUrl, token]);
  const endpointForWorkspace = useCallback(
    (workspace: RouteWorkspace | null | undefined): ResolvedWorkspaceEndpoint | null =>
      resolveWorkspaceEndpoint(workspace, localServerRef.current),
    [],
  );
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // One-way latch for "a refreshRouteState is currently running"; prevents
  // overlapping route refreshes from queueing up when the user clicks fast.
  const refreshInFlightRef = useRef(false);
  const reloadEventCursorByWorkspaceRef = useRef<Record<string, number | null>>({});
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const workspaceOrderIdsRef = useRef(workspaceOrderIds);
  const remoteWorkspaceCheckRunRef = useRef<Record<string, string>>({});
  const remoteWorkspaceCheckRunCounterRef = useRef(0);
  const sessionsByWorkspaceIdRef = useRef<Record<string, any[]>>({});
  const pendingCreatedSessionIdsRef = useRef<Record<string, Record<string, number>>>({});
  const startupRetryTimerRef = useRef<number | null>(null);
  const [retryingWorkspaceIds, setRetryingWorkspaceIds] = useState<string[]>([]);
  const launchActivatedWorkspaceIdsRef = useRef(new Set<string>());
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceError, setCreateWorkspaceError] = useState<string | null>(null);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);
  const [renameWorkspaceId, setRenameWorkspaceId] = useState<string | null>(null);
  const [renameWorkspaceTitle, setRenameWorkspaceTitle] = useState("");
  const [renameWorkspaceBusy, setRenameWorkspaceBusy] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // Model picker modal state (ported from settings-route; previously the
  // session "Pick a model" button navigated to /settings/general, which is a
  // dead-end). Loads providers lazily when the modal opens.
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [compactModelPickerOpen, setCompactModelPickerOpen] = useState(false);
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  const [permissionReplyBusy, setPermissionReplyBusy] = useState(false);
  const permissionReplyBusyRef = useRef(false);
  // Provider catalog cache. Used to compute the reasoning/thinking variant
  // options for whichever model is currently selected so the composer's
  // behavior pill actually shows its options (bug: was empty before).
  const [providerCatalog, setProviderCatalog] = useState<Record<string, Record<string, any>>>({});
  const [openworkServerHostInfoState, setOpenworkServerHostInfoState] = useState<OpenworkServerInfo | null>(null);
  useReactRenderWatchdog("SessionRoute", {
    selectedSessionId,
    selectedWorkspaceId,
    loading,
    workspaceCount: workspaces.length,
    sessionGroupCount: Object.keys(sessionsByWorkspaceId).length,
    commandPaletteOpen,
    modelPickerOpen,
  });
  const [openworkServerSettingsVersion, setOpenworkServerSettingsVersion] = useState(0);
  const [engineReloadVersion, setEngineReloadVersion] = useState(0);
  const [routeEngineInfo, setRouteEngineInfo] = useState<EngineInfo | null>(null);
  const reconnectAttemptedWorkspaceIdRef = useRef("");

  const openworkServerSettings = useMemo(
    () => readOpenworkServerSettings(),
    [openworkServerSettingsVersion],
  );

  const shareWorkspaceState = useShareWorkspaceState({
    workspaces,
    openworkServerHostInfo: openworkServerHostInfoState,
    openworkServerSettings,
    engineInfo: routeEngineInfo,
    exportWorkspaceBusy: false,
    openLink: (url) => platform.openLink(url),
    workspaceLabel,
  });

  const activeReloadBlockingSessions = useMemo(
    () =>
      Object.values(sessionsByWorkspaceId)
        .flat()
        .flatMap((session: any) => {
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

  const backgroundSessionLoadInFlight = useRef<Map<string, number>>(new Map());
  const rememberPendingCreatedSession = useCallback((workspaceId: string, sessionId: string) => {
    const id = sessionId.trim();
    if (!workspaceId || !id) return;
    pendingCreatedSessionIdsRef.current[workspaceId] = {
      ...(pendingCreatedSessionIdsRef.current[workspaceId] ?? {}),
      [id]: Date.now(),
    };
  }, []);
  const mergeFetchedSessionsWithPending = useCallback((workspaceId: string, fetched: any[], current: any[]) => {
    const pending = pendingCreatedSessionIdsRef.current[workspaceId];
    if (!pending) return fetched;

    const now = Date.now();
    const fetchedIds = new Set(fetched.flatMap((session: any) => session?.id ? [String(session.id)] : []));
    const pendingIds = Object.keys(pending);

    for (const id of pendingIds) {
      if (fetchedIds.has(id)) {
        delete pending[id];
      }
    }

    const preserved = current.filter((session: any) => {
      const id = String(session?.id ?? "");
      if (!id || fetchedIds.has(id)) return false;
      const createdAt = pending[id];
      if (typeof createdAt !== "number") return false;
      if (now - createdAt > 30_000) {
        delete pending[id];
        return false;
      }
      return true;
    });

    if (Object.keys(pending).length === 0) {
      delete pendingCreatedSessionIdsRef.current[workspaceId];
    }

    return preserved.length > 0 ? [...preserved, ...fetched] : fetched;
  }, []);
  const loadWorkspaceSessionsInBackground = useCallback(
    async (workspaces: RouteWorkspace[]) => {
      const MAX_ATTEMPTS = 6;
      const backoffMs = (attempt: number) => Math.min(500 * Math.pow(2, attempt), 4_000);

      const fetchOnce = async (workspace: RouteWorkspace, attempt: number): Promise<void> => {
        const endpoint = endpointForWorkspace(workspace);
        if (!endpoint) return;
        const startedAt = backgroundSessionLoadInFlight.current.get(workspace.id) ?? 0;
        if (startedAt && Date.now() - startedAt < 5_000) return;
        const requestStartedAt = Date.now();
        backgroundSessionLoadInFlight.current.set(workspace.id, requestStartedAt);
        try {
          const response = await endpoint.client.listSessions(endpoint.workspaceId, { limit: 200 });
          const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
          const items = workspaceRoot
            ? (response.items ?? []).filter((session: any) =>
                normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
              )
            : (response.items ?? []);
          setSessionsByWorkspaceId((current) => {
            const nextItems = mergeFetchedSessionsWithPending(workspace.id, items, current[workspace.id] ?? []);
            const next = { ...current, [workspace.id]: nextItems };
            sessionsByWorkspaceIdRef.current = next;
            return next;
          });
          setErrorsByWorkspaceId((current) => ({ ...current, [workspace.id]: null }));
          setWorkspaceConnectionOverrides((current) => {
            if (current[workspace.id]?.status !== "error") return current;
            const next = { ...current };
            delete next[workspace.id];
            return next;
          });
          setRetryingWorkspaceIds((current) =>
            current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
          );
          // When a workspace returns zero sessions during the initial batch
          // load, OpenCode may still be warming up its index.  Schedule a
          // single delayed retry so the sidebar doesn't stay permanently
          // empty while the managed engine finishes starting.
          if (items.length === 0 && attempt === 0) {
            window.setTimeout(() => {
              if (backgroundSessionLoadInFlight.current.get(workspace.id)) return;
              backgroundSessionLoadInFlight.current.delete(workspace.id);
              void fetchOnce(workspace, 1);
            }, 3_000);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : t("app.unknown_error");
          // The first cold call to OpenCode's /session endpoint often hits
          // the 12s server timeout while the daemon finishes warming up
          // its index. Retry silently with backoff until we get a response
          // or run out of attempts — the sidebar keeps its "loading" state
          // in the meantime instead of flashing "error" next to the
          // workspace name.
          if (attempt + 1 < MAX_ATTEMPTS && isTransientStartupError(message)) {
            if (backgroundSessionLoadInFlight.current.get(workspace.id) === requestStartedAt) {
              backgroundSessionLoadInFlight.current.delete(workspace.id);
            }
            await new Promise((r) => window.setTimeout(r, backoffMs(attempt)));
            await fetchOnce(workspace, attempt + 1);
            return;
          }
          // Final failure: keep local workspace startup quiet, but give
          // remote workers a precise endpoint/token/workspace diagnostic.
          if (workspace.workspaceType === "remote") {
            const connectionState = await diagnoseRemoteWorkspaceTaskLoadFailure(workspace, message);
            setErrorsByWorkspaceId((current) => ({
              ...current,
              [workspace.id]: connectionState.message ?? "Remote worker connection failed.",
            }));
            setWorkspaceConnectionOverrides((current) => {
              if (current[workspace.id]?.status === "connecting") return current;
              return {
                ...current,
                [workspace.id]: connectionState,
              };
            });
          }
          setRetryingWorkspaceIds((current) =>
            current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : current,
          );
        } finally {
          if (backgroundSessionLoadInFlight.current.get(workspace.id) === requestStartedAt) {
            backgroundSessionLoadInFlight.current.delete(workspace.id);
          }
        }
      };

      await Promise.all(workspaces.map((workspace) => fetchOnce(workspace, 0)));
    },
    [endpointForWorkspace, mergeFetchedSessionsWithPending],
  );

  const refreshRouteState = useCallback(async () => {
    // Dedupe: if a refresh is already running, skip this call. Fast workspace
    // switches used to fire 5-6 overlapping refreshRouteState() calls which
    // each fetched workspaces + sessions for every workspace. That workload
    // multiplied quickly on the event loop and caused the UI to freeze.
    if (refreshInFlightRef.current) return;
    refreshInFlightRef.current = true;
    setLoading(true);
    setRouteError(null);
    let desktopList = null as Awaited<ReturnType<typeof workspaceBootstrap>> | null;
    let desktopWorkspaces = workspacesRef.current;
    let routeReadyAfterRefresh = true;
    try {
      if (isDesktopRuntime()) {
        try {
          desktopList = await workspaceBootstrap();
          desktopWorkspaces = (desktopList.workspaces ?? []).map(mapDesktopWorkspace);
        } catch (error) {
          const message = describeRouteError(error);
          console.error("[session-route] workspaceBootstrap failed", error);
          recordInspectorEvent("route.workspace_bootstrap.error", {
            route: "session",
            message,
            preservedWorkspaceCount: workspacesRef.current.length,
          });
          desktopWorkspaces = workspacesRef.current;
        }
      }

      const { normalizedBaseUrl, resolvedToken, resolvedHostToken, hostInfo } = await resolveOpenworkConnection();
      setOpenworkServerHostInfoState(hostInfo);
      if (!normalizedBaseUrl || !resolvedToken) {
        // Keep `localServerRef` in lockstep with the disconnected state.
        // Otherwise a previously-cached baseUrl/token would still resolve a
        // (now invalid) endpoint for any callback that consults the ref.
        localServerRef.current = { baseUrl: "", token: "" };
        setClient(null);
        setBaseUrl("");
        setToken("");
        const orderedDesktopWorkspaces = orderRouteWorkspaces(desktopWorkspaces, workspaceOrderIdsRef.current);
        setWorkspaces(orderedDesktopWorkspaces);
        sessionsByWorkspaceIdRef.current = {};
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setLegacySelectedWorkspaceId(resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "");
        return;
      }

      // Update the local-server ref synchronously, BEFORE we kick off any
      // workspace-scoped requests below. `endpointForWorkspace` reads from
      // this ref synchronously; the `useEffect` that mirrors `[baseUrl,
      // token]` into the ref doesn't run until after the next React commit,
      // which is too late for the `activateWorkspace` and
      // `loadWorkspaceSessionsInBackground` calls that fire later in this
      // function. Stale ref => `resolveWorkspaceEndpoint` returns null for
      // local workspaces => sidebar gets stuck in "loading" forever.
      localServerRef.current = { baseUrl: normalizedBaseUrl, token: resolvedToken };

      const openworkClient = createOpenworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
        hostToken: resolvedHostToken || undefined,
      });
      const list = await openworkClient.listWorkspaces();
      const nextWorkspaces = orderRouteWorkspaces(
        mergeRouteWorkspaces(list.items, desktopWorkspaces),
        workspaceOrderIdsRef.current,
      );

      // Preserve any sessions we already have cached so switching routes
      // doesn't erase the sidebar while we refetch.
      const alreadyLoadedWorkspaceIds = new Set(Object.keys(sessionsByWorkspaceIdRef.current));
      const cachedEntries = nextWorkspaces.map((workspace) => ({
        workspaceId: workspace.id,
        sessions: sessionsByWorkspaceIdRef.current[workspace.id] ?? [],
      }));
      // Prefer, in order: the URL-selected workspace (if it owns the session),
      // the user's last-active workspace from localStorage, the desktop's
      // activeId, the server's activeId, then the first known workspace.
      const persistedActiveId = readActiveWorkspaceId();
      let nextWorkspaceId =
        (routeWorkspaceId && nextWorkspaces.some((w) => w.id === routeWorkspaceId)
          ? routeWorkspaceId
          : "") ||
        (persistedActiveId && nextWorkspaces.some((w) => w.id === persistedActiveId)
          ? persistedActiveId
          : "") ||
        resolveWorkspaceListSelectedId(desktopList) ||
        list.activeId?.trim() ||
        nextWorkspaces[0]?.id ||
        "";
      if (selectedSessionId) {
        const match = cachedEntries.find((entry) =>
          entry.sessions.some((session: any) => session?.id === selectedSessionId),
        );
        if (match?.workspaceId) nextWorkspaceId = match.workspaceId;
      }

      setClient(openworkClient);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      const nextSessionsByWorkspaceId = Object.fromEntries(cachedEntries.map((entry) => [entry.workspaceId, entry.sessions]));
      sessionsByWorkspaceIdRef.current = nextSessionsByWorkspaceId;
      setSessionsByWorkspaceId(nextSessionsByWorkspaceId);
      setErrorsByWorkspaceId((previous) => {
        const next: Record<string, string | null> = {};
        for (const workspace of nextWorkspaces) {
          next[workspace.id] = previous[workspace.id] ?? null;
        }
        return next;
      });
      setRetryingWorkspaceIds(
        cachedEntries.flatMap((entry) =>
          entry.sessions.length === 0 &&
          (entry.workspaceId === nextWorkspaceId || !alreadyLoadedWorkspaceIds.has(entry.workspaceId))
            ? [entry.workspaceId]
            : [],
        ),
      );
      setLegacySelectedWorkspaceId(nextWorkspaceId);
      writeActiveWorkspaceId(nextWorkspaceId || null);
      // Mark the chosen workspace as active on the server so that the
      // OpenCode engine bound to it re-reads opencode.jsonc and applies
      // permissions. Fire-and-forget; the route is idempotent and any
      // transport failure is non-fatal. See issue #870.
      if (nextWorkspaceId && !launchActivatedWorkspaceIdsRef.current.has(nextWorkspaceId)) {
        launchActivatedWorkspaceIdsRef.current.add(nextWorkspaceId);
        const nextWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId) ?? null;
        const nextEndpoint = endpointForWorkspace(nextWorkspace);
        if (nextEndpoint) {
          void nextEndpoint.client.activateWorkspace(nextEndpoint.workspaceId).catch(() => undefined);
        }
      }
      recordInspectorEvent("route.refresh.complete", {
        workspaces: nextWorkspaces.length,
        selectedWorkspaceId: nextWorkspaceId,
        errors: {},
      });

      // Session list comes from OpenCode's index and can be slow on cold
      // boot. Kick it off in the background instead of blocking the route
      // so the UI is interactive immediately; the sidebar shows a
      // loading state per-workspace until the list arrives.
      const selectedWorkspace = nextWorkspaces.find((workspace) => workspace.id === nextWorkspaceId);
      const backgroundWorkspaces = nextWorkspaces.filter(
        (workspace) => workspace.id === nextWorkspaceId || !alreadyLoadedWorkspaceIds.has(workspace.id),
      );
      if (backgroundWorkspaces.length > 0) {
        const orderedWorkspaces = selectedWorkspace
          ? [selectedWorkspace, ...backgroundWorkspaces.filter((workspace) => workspace.id !== selectedWorkspace.id)]
          : backgroundWorkspaces;
        void loadWorkspaceSessionsInBackground(orderedWorkspaces);
      }
    } catch (error) {
      const message = describeRouteError(error);
      console.error("[session-route] refreshRouteState failed", error);
      recordInspectorEvent("route.refresh.error", {
        route: "session",
        message,
        preservedWorkspaceCount: desktopWorkspaces.length,
      });
      setRouteError(message);
      if (desktopWorkspaces.length > 0) {
        const orderedDesktopWorkspaces = orderRouteWorkspaces(desktopWorkspaces, workspaceOrderIdsRef.current);
        setWorkspaces(orderedDesktopWorkspaces);
        setLegacySelectedWorkspaceId((current) =>
          current || resolveWorkspaceListSelectedId(desktopList) || orderedDesktopWorkspaces[0]?.id || "",
        );
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      // Tell the boot overlay the first route data load has completed so
      // the overlay dismisses after BOTH the desktop boot and the workspace
      // list/sessions are ready.
      if (routeReadyAfterRefresh) {
        markBootRouteReady();
      }
    }
  }, [loadWorkspaceSessionsInBackground, markBootRouteReady, routeWorkspaceId, selectedSessionId]);

  const remoteAccessRestart = useRemoteAccessRestart({
    isEnabled: () => openworkServerSettings.remoteAccessEnabled === true,
    onHostInfo: setOpenworkServerHostInfoState,
    onSettingsChanged: () => setOpenworkServerSettingsVersion((value) => value + 1),
  });

  const reloadWorkspaceEngineFromUi = useCallback(async () => {
    if (!client || !selectedWorkspaceId) {
      setRouteError(t("app.error_connect_first"));
      return false;
    }
    const endpoint = endpointForWorkspace(selectedWorkspace);
    if (!endpoint) {
      setRouteError(t("app.error_connect_first"));
      return false;
    }
    await endpoint.client.reloadEngine(endpoint.workspaceId);
    setEngineReloadVersion((v) => v + 1);
    try {
      window.dispatchEvent(new CustomEvent("openwork-server-settings-changed"));
    } catch {
      // ignore browser event dispatch failures
    }
    await refreshRouteState();
    return true;
  }, [client, endpointForWorkspace, refreshRouteState, selectedWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    return reloadCoordinator.registerWorkspaceReloadControls({
      canReloadWorkspaceEngine: () => Boolean(client && selectedWorkspaceId),
      reloadWorkspaceEngine: reloadWorkspaceEngineFromUi,
      activeSessions: () => activeReloadBlockingSessions,
    });
  }, [activeReloadBlockingSessions, client, reloadCoordinator, reloadWorkspaceEngineFromUi, selectedWorkspaceId]);

  useEffect(() => {
    if (!client || !selectedWorkspaceId) return;
    const endpoint = endpointForWorkspace(selectedWorkspace);
    if (!endpoint) return;
    let cancelled = false;

    const pollReloadEvents = async () => {
      const currentCursor = reloadEventCursorByWorkspaceRef.current[selectedWorkspaceId];
      try {
        const response = await endpoint.client.listReloadEvents(
          endpoint.workspaceId,
          typeof currentCursor === "number" ? { since: currentCursor } : undefined,
        );
        if (cancelled) return;
        reloadEventCursorByWorkspaceRef.current[selectedWorkspaceId] =
          typeof response.cursor === "number"
            ? response.cursor
            : Math.max(currentCursor ?? 0, ...((response.items ?? []).map((item: any) => Number(item.seq) || 0)));
        // The first poll establishes the server cursor so historical reload
        // events don't show a stale toast on route entry. Subsequent polls mark
        // new filesystem/server-side mutations, including skills created by an
        // agent while the session page is open.
        if (currentCursor === undefined || currentCursor === null) return;
        for (const event of response.items ?? []) {
          reloadCoordinator.markReloadRequired(event.reason, event.trigger);
        }
      } catch {
        // Reload-event polling is best-effort; normal route health checks still
        // surface connection failures.
      }
    };

    void pollReloadEvents();
    const interval = window.setInterval(() => void pollReloadEvents(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, endpointForWorkspace, reloadCoordinator, selectedWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId) return;
    const endpoint = endpointForWorkspace(selectedWorkspace);
    if (!endpoint) return;
    let cancelled = false;

    const refreshSelectedSessionTitle = async () => {
      try {
        const response = await endpoint.client.getSession(endpoint.workspaceId, selectedSessionId);
        if (cancelled || !response.item) return;
        setSessionsByWorkspaceId((current) => {
          const list = current[selectedWorkspaceId] ?? [];
          const index = list.findIndex((session: any) => session?.id === selectedSessionId);
          if (index < 0) return current;
          const nextSession = { ...list[index], ...response.item };
          if (JSON.stringify(nextSession) === JSON.stringify(list[index])) return current;
          const nextList = [...list];
          nextList[index] = nextSession;
          return { ...current, [selectedWorkspaceId]: nextList };
        });
      } catch {
        // Best-effort title sync; the session surface still owns messages.
      }
    };

    void refreshSelectedSessionTitle();
    const interval = window.setInterval(() => void refreshSelectedSessionTitle(), 3_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [client, endpointForWorkspace, selectedSessionId, selectedWorkspace, selectedWorkspaceId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

  useEffect(() => {
    workspaceOrderIdsRef.current = workspaceOrderIds;
  }, [workspaceOrderIds]);

  useEffect(() => {
    const activeWorkspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    setWorkspaceConnectionOverrides((current) => {
      let changed = false;
      const next: Record<string, WorkspaceConnectionState> = {};
      for (const [workspaceId, state] of Object.entries(current)) {
        if (activeWorkspaceIds.has(workspaceId)) {
          next[workspaceId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [workspaces]);

  useEffect(() => {
    sessionsByWorkspaceIdRef.current = sessionsByWorkspaceId;
  }, [sessionsByWorkspaceId]);

  const handleRemoteWorkspaceConnectionSaved = useCallback(
    async (workspaceId: string) => {
      delete remoteWorkspaceCheckRunRef.current[workspaceId];
      setWorkspaceConnectionOverrides((current) => {
        const next = { ...current };
        delete next[workspaceId];
        return next;
      });
      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspaceId));
      await refreshRouteState();
    },
    [refreshRouteState],
  );

  const remoteWorkspaceConnectionEditor = useRemoteWorkspaceConnectionEditor({
    workspaces,
    onSaved: handleRemoteWorkspaceConnectionSaved,
  });

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        if (cancelled) return;
        await refreshRouteState();
      } finally {
        if (cancelled) return;
      }
    })();

    const handleSettingsChange = () => {
      setOpenworkServerSettingsVersion((value) => value + 1);
      // Self-heal: if the previous refresh got stuck mid-flight (e.g. macOS
      // backgrounded the webview and never let a fetch resolve), clear the
      // guard so a re-entry after resume actually goes through.
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    window.addEventListener("openwork-server-settings-changed", handleSettingsChange);

    // Also retry on visibility flip independently — even when nobody else
    // dispatches the settings event.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState !== "visible") return;
      refreshInFlightRef.current = false;
      void refreshRouteState();
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      cancelled = true;
      if (startupRetryTimerRef.current !== null) {
        window.clearTimeout(startupRetryTimerRef.current);
        startupRetryTimerRef.current = null;
      }
      window.removeEventListener("openwork-server-settings-changed", handleSettingsChange);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
  }, [refreshRouteState]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let cancelled = false;
    void engineInfo()
      .then((info) => {
        if (!cancelled) setRouteEngineInfo(info);
      })
      .catch(() => {
        if (!cancelled) setRouteEngineInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Inspector wiring: publish the route's current state so an external
  // operator (or an AI driver like Chrome MCP) can call
  // `window.__openwork.snapshot()` or `window.__openwork.slice("route")` and
  // see workspaces / sessions / connection info without walking the DOM.
  useEffect(() => {
    const dispose = publishInspectorSlice("route", () => ({
      loading,
      retryingWorkspaceIds,
      baseUrl,
      tokenPresent: token.length > 0,
      connected: Boolean(client),
      routeError,
      selectedSessionId,
      selectedWorkspaceId,
      persistedActiveWorkspaceId: readActiveWorkspaceId(),
      workspaces: workspaces.map((workspace) => ({
        id: workspace.id,
        displayNameResolved: workspace.displayNameResolved,
        workspaceType: workspace.workspaceType,
        path: workspace.path,
        sessionCount: (sessionsByWorkspaceId[workspace.id] ?? []).length,
        loading: retryingWorkspaceIds.includes(workspace.id),
        error: errorsByWorkspaceId[workspace.id] ?? null,
      })),
      sessionsByWorkspaceId: Object.fromEntries(
        Object.entries(sessionsByWorkspaceId).map(([wsId, items]) => [
          wsId,
          (items ?? []).map((session: any) => ({
            id: session?.id ?? null,
            title: session?.title ?? null,
            directory: session?.directory ?? null,
          })),
        ]),
      ),
    }));
    return dispose;
  }, [
    baseUrl,
    client,
    errorsByWorkspaceId,
    loading,
    retryingWorkspaceIds,
    selectedSessionId,
    selectedWorkspaceId,
    routeError,
    sessionsByWorkspaceId,
    token,
    workspaces,
  ]);

  // Once workspaces + sessions are loaded and the URL has no sessionId, try to
  // restore the last session the user opened in the active workspace.
  useEffect(() => {
    if (loading) return;
    if (routeWorkspaceId && workspaces.length > 0 && !workspaces.some((workspace) => workspace.id === routeWorkspaceId)) {
      const fallbackWorkspaceId = workspaces.some((workspace) => workspace.id === legacySelectedWorkspaceId)
        ? legacySelectedWorkspaceId
        : workspaces[0]?.id || "";
      if (fallbackWorkspaceId) {
        navigateToWorkspaceSession(fallbackWorkspaceId, selectedSessionId, { replace: true });
      }
      return;
    }
    if (!routeWorkspaceId && selectedWorkspaceId) {
      navigateToWorkspaceSession(selectedWorkspaceId, selectedSessionId, { replace: true });
      return;
    }
    if (selectedSessionId) return;
    if (!selectedWorkspaceId) return;
    const remembered = readLastSessionFor(selectedWorkspaceId);
    if (!remembered) return;
    const sessions = sessionsByWorkspaceId[selectedWorkspaceId] ?? [];
    if (!sessions.some((session: any) => session?.id === remembered)) return;
    navigateToWorkspaceSession(selectedWorkspaceId, remembered, { replace: true });
  }, [
    loading,
    legacySelectedWorkspaceId,
    navigateToWorkspaceSession,
    routeWorkspaceId,
    selectedSessionId,
    selectedWorkspaceId,
    sessionsByWorkspaceId,
    workspaces,
  ]);

  // Redirect to /welcome when no workspaces exist and the user hasn't
  // completed onboarding. This fires after the initial route refresh so
  // `loading` is false and we know for sure there are zero workspaces.
  useEffect(() => {
    if (loading) return;
    if (workspaces.length > 0) return;
    if (local.prefs.hasCompletedOnboarding) return;
    navigate("/welcome", { replace: true });
  }, [loading, local.prefs.hasCompletedOnboarding, navigate, workspaces.length]);

  // NOTE: Blueprint seeding was removed from the route.
  // It was firing `materializeBlueprintSessions` + a session re-fetch on every
  // workspace change, which cascaded setState updates and froze the UI after
  // a few rapid switches. Empty workspaces now simply show "No tasks yet." and
  // the user creates their first session explicitly via "New task". Seeding
  // can be reintroduced later as a one-shot triggered from a button or from
  // the onboarding flow, not from the route effect loop.

  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId, new Set(retryingWorkspaceIds)),
    [errorsByWorkspaceId, retryingWorkspaceIds, sessionsByWorkspaceId, workspaces],
  );

  const sidebarActiveWorkspaceId = useMemo(() => {
    const sessionId = selectedSessionId?.trim() ?? "";
    if (sessionId) {
      const owner = workspaceSessionGroups.find((group) =>
        group.sessions.some((session: any) => session?.id === sessionId),
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

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    if (loading) return;
    if (client) {
      reconnectAttemptedWorkspaceIdRef.current = "";
      return;
    }
    if (!selectedWorkspace || selectedWorkspace.workspaceType !== "local") return;
    const workspaceId = selectedWorkspace.id?.trim() ?? "";
    if (!workspaceId || reconnectAttemptedWorkspaceIdRef.current === workspaceId) return;
    reconnectAttemptedWorkspaceIdRef.current = workspaceId;

    void ensureDesktopLocalOpenworkConnection({
      route: "session",
      workspace: selectedWorkspace,
      allWorkspaces: workspaces,
    }).catch((error) => {
      const message = error instanceof Error ? error.message : describeRouteError(error);
      setRouteError(message);
    });
  }, [client, loading, selectedWorkspace, workspaces]);

  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  // Single source of truth for the selected workspace's server URL/token/id.
  // For remote workspaces this is the worker that owns the workspace; for
  // local workspaces it's the user's local OpenWork server.
  const selectedWorkspaceEndpoint = useMemo(
    () => resolveWorkspaceEndpoint(selectedWorkspace, { baseUrl, token }),
    [baseUrl, selectedWorkspace, token],
  );
  const selectedWorkspaceServerToken = selectedWorkspaceEndpoint?.token ?? "";
  const opencodeBaseUrl = selectedWorkspaceEndpoint?.opencodeBaseUrl ?? "";
  const selectedWorkspaceIsLoading = retryingWorkspaceIds.includes(selectedWorkspaceId);
  const selectedWorkspaceError = errorsByWorkspaceId[selectedWorkspaceId] ?? null;
  const selectedSessionKnown = Boolean(
    selectedSessionId &&
      (sessionsByWorkspaceId[selectedWorkspaceId] ?? []).some((session: any) => session?.id === selectedSessionId),
  );
  const routeNotFoundMessage = (() => {
    if (loading) return null;
    if (routeWorkspaceId && !selectedWorkspace) {
      return "Workspace was not found. Select a new workspace from the sidebar.";
    }
    if (selectedSessionId && !selectedWorkspaceIsLoading && !selectedSessionKnown) {
      return "Session was not found. Select a new session from the sidebar.";
    }
    return null;
  })();
  // Boot-level loading blocks the whole UI. Session-list retries only fill the
  // sidebar; they must not gate the composer/New task.
  const effectiveLoading = loading;

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && selectedWorkspaceServerToken && !selectedWorkspaceError
        ? createClient(opencodeBaseUrl, selectedWorkspaceRoot || undefined, {
            token: selectedWorkspaceServerToken,
            mode: "openwork",
          })
        : null,
    [opencodeBaseUrl, selectedWorkspaceError, selectedWorkspaceRoot, selectedWorkspaceServerToken],
  );
  const canCreateTask = Boolean(
    opencodeClient && selectedWorkspaceId && !loading && !selectedWorkspaceError,
  );
  const permissionQueryKey = useMemo(
    () =>
      selectedWorkspaceId && selectedSessionId
        ? reactPermissionKey(selectedWorkspaceId, selectedSessionId)
        : null,
    [selectedSessionId, selectedWorkspaceId],
  );
  const pendingPermissions = useQueryCacheState<PendingPermission[]>(
    permissionQueryKey,
    emptyPendingPermissions,
  );
  useEffect(() => {
    if (!opencodeClient || !selectedWorkspaceId || !selectedSessionId) return;
    let cancelled = false;
    const directory = selectedWorkspaceRoot || undefined;
    void (async () => {
      const snapshotStartedAt = Date.now();
      try {
        const list = unwrap(await opencodeClient.permission.list({ directory }));
        if (!cancelled) {
          seedPermissionState(selectedWorkspaceId, selectedSessionId, list, { snapshotStartedAt });
        }
      } catch {
        // Keep event-synced permission state if the snapshot read fails.
        // Hiding a pending approval can block the running task.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opencodeClient, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot]);

  const activePermission = pendingPermissions[0] ?? null;
  const respondPermission = useCallback(
    async (requestID: string, reply: "once" | "always" | "reject") => {
      if (!opencodeClient || !selectedWorkspaceId || !selectedSessionId) return;
      if (permissionReplyBusyRef.current) return;
      permissionReplyBusyRef.current = true;
      setPermissionReplyBusy(true);
      try {
        unwrap(
          await opencodeClient.permission.reply({
            requestID,
            reply,
            directory: selectedWorkspaceRoot || undefined,
          }),
        );
        getReactQueryClient().setQueryData<PendingPermission[]>(
          reactPermissionKey(selectedWorkspaceId, selectedSessionId),
          (current = []) => current.filter((permission) => permission.id !== requestID),
        );
      } catch (error) {
        showToast({
          title: t("app.error_request_failed"),
          description: describeRouteError(error),
          tone: "error",
        });
      } finally {
        permissionReplyBusyRef.current = false;
        setPermissionReplyBusy(false);
      }
    },
    [opencodeClient, selectedSessionId, selectedWorkspaceId, selectedWorkspaceRoot, showToast],
  );
  const showPreparingStatus =
    effectiveLoading ||
    (!canCreateTask && !routeError && !selectedWorkspaceError);

  useEffect(() => {
    if (!opencodeClient) {
      setProviders([]);
      setProviderConnectedIds([]);
      return;
    }

    let cancelled = false;

    const applyProviderState = (value: ProviderListResponse) => {
      if (cancelled) return;
      setProviders((value.all ?? []) as ProviderListItem[]);
      setProviderConnectedIds(value.connected ?? []);
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
      } catch {
        // ignore config read failures and continue with provider discovery
      }

      try {
        applyProviderState(
          filterProviderList(
            unwrap(await opencodeClient.provider.list()),
            disabledProviders,
          ),
        );
      } catch {
        try {
          const fallback = unwrap(
            await opencodeClient.config.providers({
              directory: selectedWorkspaceRoot || undefined,
            }),
          ) as ConfigProvidersResponse;
          applyProviderState(
            filterProviderList(
              {
                all: mapConfigProvidersToList(
                  fallback.providers,
                ) as ProviderListResponse["all"],
                connected: [],
                default: fallback.default,
              },
              disabledProviders,
            ),
          );
        } catch {
          if (cancelled) return;
          setProviders([]);
          setProviderConnectedIds([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [opencodeClient, selectedWorkspaceRoot]);

  const modelLabel = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
    : t("session.default_model");

  // Prefetch the full provider catalog once so `getModelBehaviorSummary` has
  // everything it needs to expose the reasoning/thinking variants the active
  // model supports — without waiting for the model picker to open. Cached
  // as providerID → modelID → ProviderModel.
  useEffect(() => {
    if (!opencodeClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await opencodeClient.config.providers({
          directory: selectedWorkspaceRoot || undefined,
        });
        const data = (res as { data?: { providers?: Array<{ id: string; models: Record<string, any> }> } }).data;
        if (cancelled || !data?.providers) return;
        const next: Record<string, Record<string, any>> = {};
        for (const provider of data.providers) {
          next[provider.id] = { ...(provider.models ?? {}) };
        }
        setProviderCatalog(next);
      } catch {
        // best-effort cache; UI will fall back to empty variant options.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [opencodeClient, selectedWorkspaceRoot]);

  // Compute behavior (reasoning/thinking variant) options for the current
  // default model. This is what the composer renders as its variant pill.
  const { modelVariantLabel, modelBehaviorOptions, modelVariantValue } = useMemo(() => {
    const ref = local.prefs.defaultModel;
    const variant = local.prefs.modelVariant ?? null;
    if (!ref) {
      return {
        modelVariantLabel: t("settings.default_label"),
        modelBehaviorOptions: emptyModelBehaviorOptions,
        modelVariantValue: null,
      };
    }
    const model = providerCatalog[ref.providerID]?.[ref.modelID];
    if (!model) {
      return {
        modelVariantLabel: variant ?? t("settings.default_label"),
        modelBehaviorOptions: emptyModelBehaviorOptions,
        modelVariantValue: variant,
      };
    }
    const summary = getModelBehaviorSummary(ref.providerID, model, variant);
    return {
      modelVariantLabel: summary.label,
      modelBehaviorOptions: summary.options,
      modelVariantValue: summary.value,
    };
  }, [local.prefs.defaultModel, local.prefs.modelVariant, providerCatalog]);

  // Load the picker list lazily the first time the modal opens. Uses the
  // cached catalog when available, otherwise re-fetches.
  useEffect(() => {
    if (!modelPickerOpen || !opencodeClient) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await opencodeClient.config.providers({
          directory: selectedWorkspaceRoot || undefined,
        });
        const data = (res as {
          data?: {
            providers?: Array<{
              id: string;
              name: string;
              models: Record<string, { id: string; name: string }>;
            }>;
          };
        }).data;
        if (cancelled || !data?.providers) return;
        const options: ModelOption[] = [];
        for (const provider of data.providers) {
          const modelIds = Object.keys(provider.models);
          const hasModels = modelIds.length > 0;
          for (const id of modelIds) {
            const model = provider.models[id];
            options.push({
              providerID: provider.id,
              modelID: id,
              title: model.name || id,
              description: provider.name,
              behaviorTitle: "Reasoning",
              behaviorLabel: "Default",
              behaviorDescription: "",
              behaviorValue: null,
              isFree: false,
              isConnected: hasModels,
            });
          }
        }
        setModelOptions(options);
      } catch {
        // Silent: the picker surfaces an empty list rather than blocking the UI.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelPickerOpen, opencodeClient, selectedWorkspaceRoot]);

  // Apply org-level restrictions (dev #1505) on top of the raw model list
  // so the picker never surfaces blocked options:
  //   - `blockZenModel` hides the built-in OpenCode provider entries
  //   - `disallowNonCloudModels` hides providers that aren't currently
  //     connected via cloud (a provider with models[] filled counts as
  //     connected in this list — see the loader above)
  const allowedModelOptions = useMemo(() => {
    const restrictToCloud = checkDesktopRestriction({
      restriction: "disallowNonCloudModels",
    });
    return modelOptions.filter((option) => {
      if (
        isDesktopProviderBlocked({
          providerId: option.providerID,
          checkRestriction: checkDesktopRestriction,
        })
      ) {
        return false;
      }
      if (restrictToCloud && !option.isConnected) {
        return false;
      }
      return true;
    });
  }, [checkDesktopRestriction, modelOptions]);

  const listSlashCommands = useCallback(async (): Promise<SlashCommandOption[]> => {
    // engineReloadVersion is included so the callback identity changes after
    // an engine reload, which invalidates the composer's command list cache
    // and causes it to re-fetch (picking up newly created skills).
    void engineReloadVersion;
    if (!opencodeClient) return [];
    return listCommands(opencodeClient, selectedWorkspaceRoot || undefined);
  }, [engineReloadVersion, opencodeClient, selectedWorkspaceRoot]);

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
      if ((sessions ?? []).some((session: any) => session?.id === selectedSessionId)) {
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
        setModelPickerQuery("");
        setModelPickerOpen(true);
      },
      modelPickerOpen: compactModelPickerOpen,
      selectedModel: local.prefs.defaultModel ?? { providerID: "", modelID: "" },
      onModelPickerOpenChange: setCompactModelPickerOpen,
      onModelChange: (model: ModelRef) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
        setCompactModelPickerOpen(false);
      },
      onOpenSettingsSection: (section: "commands" | "skills" | "mcps" | "plugins") => {
        handleOpenSettings(section === "skills" ? "/settings/skills" : section === "mcps" ? "/settings/extensions/mcp" : section === "plugins" ? "/settings/extensions/plugins" : "/settings/general");
      },
      onSendDraft: async (draft: ComposerDraft) => {
        const text = (draft.resolvedText ?? draft.text).trim();
        if (!text && draft.attachments.length === 0) return;

        if (draft.mode === "shell") {
          await shellInSession(opencodeClient, selectedSessionId, text);
          return;
        }

        if (draft.command) {
          const result = await opencodeClient.session.command({
            sessionID: selectedSessionId,
            command: draft.command.name,
            arguments: draft.command.arguments,
          });
          if (result.error) {
            throw new Error(serializeSDKError(result.error));
          }
          return;
        }

        const parts = await draftToParts(draft, selectedWorkspaceRoot);
        const envRuntimeKey = buildOpenworkEnvRuntimeKey({
          baseUrl: client?.baseUrl ?? null,
          pid: openworkServerHostInfoState?.pid ?? null,
          port: openworkServerHostInfoState?.port ?? null,
        });
        const envSystemContext = await buildOpenworkEnvSystemContext(client, {
          cacheKey: selectedSessionId,
          runtimeKey: envRuntimeKey,
        });
        const result = await opencodeClient.session.promptAsync({
          sessionID: selectedSessionId,
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
      listAgents: async () => {
        const list = unwrap(await opencodeClient.app.agents());
        return list.filter((agent) => !agent.hidden && agent.mode !== "subagent");
      },
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
      onChangeModel: (model: { providerID: string; modelID: string }) => {
        local.setPrefs((previous) => ({
          ...previous,
          defaultModel: model,
          modelVariant: previous.defaultModel?.providerID === model.providerID && previous.defaultModel.modelID === model.modelID
            ? previous.modelVariant
            : null,
        }));
      },
    };
  }, [
    client,
    compactModelPickerOpen,
    handleOpenSettings,
    local,
    listSlashCommands,
    modelBehaviorOptions,
    modelLabel,
    modelVariantLabel,
    modelVariantValue,
    navigate,
    opencodeBaseUrl,
    opencodeClient,
    selectedAgent,
    selectedSessionId,
    selectedWorkspace,
    selectedWorkspaceId,
    selectedWorkspaceRoot,
    sessionsByWorkspaceId,
    token,
  ]);

  const handleOpenCreateWorkspace = useCallback(() => {
    // Respect the org-level `blockMultipleWorkspaces` restriction (dev
    // #1505). If the checker returns true, the admin has disabled
    // adding further workspaces; surface a friendly notice instead of
    // opening the modal.
    if (
      workspaces.length > 0 &&
      checkDesktopRestriction({ restriction: "blockMultipleWorkspaces" })
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
      // Rename on both ends so the sidebar reflects the change regardless of
      // which list wins the next refresh (server-provided routeWorkspaces or
      // desktop-provided workspaceBootstrap results). Either call failing on
      // its own should NOT block the other — the user's intent was "rename
      // this workspace" and a soft failure in one store is recoverable.
      if (isDesktopRuntime()) {
        await workspaceUpdateDisplayName({
          workspaceId: renameWorkspaceId,
          displayName: trimmed,
        }).catch(() => undefined);
      }
      if (client) {
        await client
          .updateWorkspaceDisplayName(renameWorkspaceId, trimmed)
          .catch(() => undefined);
      }
      setRenameWorkspaceId(null);
      setRenameWorkspaceTitle("");
      await refreshRouteState();
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
      if (!isDesktopRuntime()) return;
      const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
      if (!workspace) return;
      const outputPath = await pickDirectory({
        title: `Choose where to export ${workspaceLabel(workspace)}`,
      });
      const targetPath = Array.isArray(outputPath) ? outputPath[0] : outputPath;
      if (!targetPath) return;
      await workspaceExportConfig({ workspaceId, outputPath: targetPath });
      try {
        await revealDesktopItemInDir(targetPath);
      } catch {
        // ignore reveal failures
      }
    },
    [workspaces],
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
      if (isDesktopRuntime()) {
        await workspaceForget(workspaceId).catch(() => undefined);
      }
      if (client) {
        await client.deleteWorkspace(workspaceId).catch(() => undefined);
      }
      if (selectedWorkspaceId === workspaceId) {
        setLegacySelectedWorkspaceId("");
        writeActiveWorkspaceId(null);
        navigate(legacySessionRoute());
      }
      forgetWorkspaceMemory(workspaceId);
      await refreshRouteState();
    },
    [client, navigate, refreshRouteState, selectedWorkspaceId],
  );

  const runRemoteWorkspaceConnectionCheck = useCallback(
    async (workspaceId: string, mode: "test" | "recover") => {
      const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (!workspace || workspace.workspaceType !== "remote") return false;
      const connectionKey = getRemoteWorkspaceConnectionKey(workspace);
      remoteWorkspaceCheckRunCounterRef.current += 1;
      const runId = String(remoteWorkspaceCheckRunCounterRef.current);
      remoteWorkspaceCheckRunRef.current[workspaceId] = runId;

      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: {
          status: "connecting",
          message: t("config.testing_connection"),
          checkedAt: null,
        },
      }));

      const result = await testRemoteWorkspaceConnection(workspace);
      const currentWorkspace = workspacesRef.current.find((item) => item.id === workspaceId);
      if (
        remoteWorkspaceCheckRunRef.current[workspaceId] !== runId ||
        !currentWorkspace ||
        getRemoteWorkspaceConnectionKey(currentWorkspace) !== connectionKey
      ) {
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }
      setWorkspaceConnectionOverrides((current) => ({
        ...current,
        [workspaceId]: result.state,
      }));

      if (!result.ok) {
        setErrorsByWorkspaceId((current) => ({
          ...current,
          [workspaceId]: result.state.message ?? "Remote worker connection failed.",
        }));
        if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
          delete remoteWorkspaceCheckRunRef.current[workspaceId];
        }
        return false;
      }

      setErrorsByWorkspaceId((current) => ({ ...current, [workspaceId]: null }));
      setRetryingWorkspaceIds((current) => current.filter((id) => id !== workspaceId));
      if (mode === "recover") {
        await refreshRouteState();
      }
      if (remoteWorkspaceCheckRunRef.current[workspaceId] === runId) {
        delete remoteWorkspaceCheckRunRef.current[workspaceId];
      }
      return true;
    },
    [refreshRouteState],
  );

  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (
      !workspace ||
      loading ||
      retryingWorkspaceIds.includes(workspaceId) ||
      errorsByWorkspaceId[workspaceId]
    ) {
      return;
    }
    const endpoint = resolveWorkspaceEndpoint(workspace, { baseUrl, token });
    if (!endpoint || !endpoint.token) {
      return;
    }
    const workspaceClient = createClient(
      endpoint.opencodeBaseUrl,
      workspace.path?.trim() || undefined,
      { token: endpoint.token, mode: "openwork" },
    );
    try {
      const session = unwrap(
        await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
      );
      setLegacySelectedWorkspaceId(workspaceId);
      writeActiveWorkspaceId(workspaceId || null);
      writeLastSessionFor(workspaceId, session.id);
      rememberPendingCreatedSession(workspaceId, session.id);
      setSessionsByWorkspaceId((current) => {
        const next = {
          ...current,
          [workspaceId]: [session as any, ...(current[workspaceId] ?? [])],
        };
        sessionsByWorkspaceIdRef.current = next;
        return next;
      });
      navigateToWorkspaceSession(workspaceId, session.id);
      focusPromptSoon();
      void refreshRouteState();
    } catch (error) {
      const message = describeRouteError(error);
      setRouteError(message);
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
    }
  }, [baseUrl, errorsByWorkspaceId, loading, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession, retryingWorkspaceIds, token, workspaces]);

  // Global shortcuts:
  //   Cmd/Ctrl+N  -> new task in selected workspace
  //   Cmd/Ctrl+K  -> toggle command palette
  const handleGlobalShortcut = useEffectEvent((event: KeyboardEvent) => {
    const isMac = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod) return;
    if (event.shiftKey || event.altKey) return;

    const target = event.target as HTMLElement | null;
    const inEditable =
      !!target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable);

    const key = event.key?.toLowerCase();
    if (key === "n" && !inEditable) {
      event.preventDefault();
      if (canCreateTask && selectedWorkspaceId) {
        void handleCreateTaskInWorkspace(selectedWorkspaceId);
      }
      return;
    }
    if (key === "k") {
      event.preventDefault();
      setCommandPaletteOpen((value) => !value);
    }
  });

  useEffect(() => {
    const handler = (event: KeyboardEvent) => handleGlobalShortcut(event);
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const navigateToSessionForControl = useCallback((sessionId: string) => {
    const owner = Object.entries(sessionsByWorkspaceId).find(([, sessions]) =>
      (sessions ?? []).some((session: any) => session?.id === sessionId),
    )?.[0];
    navigateToWorkspaceSession(owner || selectedWorkspaceId, sessionId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId, sessionsByWorkspaceId]);

  const navigateToSessionRootForControl = useCallback(() => {
    navigateToWorkspaceSession(selectedWorkspaceId);
  }, [navigateToWorkspaceSession, selectedWorkspaceId]);

  const openModelPickerForControl = useCallback(() => {
    setModelPickerOpen(true);
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

  const commandPaletteControlAction = useMemo<OpenworkControlAction>(() => ({
    id: "command_palette.open",
    label: "Open the command palette",
    description: "Open the in-app command palette so the next choice is visible.",
    sideEffect: "none",
    execute: () => setCommandPaletteOpen(true),
  }), []);
  useControlAction(commandPaletteControlAction);

  const paletteSessionOptions = useMemo<PaletteSessionOption[]>(() => {
    const out: PaletteSessionOption[] = [];
    for (const workspace of workspaces) {
      const workspaceTitle =
        workspace.displayName?.trim() ||
        workspace.name?.trim() ||
        workspace.path?.trim() ||
        t("session.workspace_fallback");
      const list = sessionsByWorkspaceId[workspace.id] ?? [];
      for (const session of list) {
        const sessionId = (session as { id?: string }).id?.trim() ?? "";
        if (!sessionId) continue;
        const title = getDisplaySessionTitle(
          (session as { title?: string }).title ?? "",
        );
        const updatedAt =
          (session as { time?: { updated?: number; created?: number } }).time
            ?.updated ??
          (session as { time?: { updated?: number; created?: number } }).time
            ?.created ??
          0;
        out.push({
          workspaceId: workspace.id,
          sessionId,
          title,
          workspaceTitle,
          updatedAt,
          searchText: `${title} ${workspaceTitle}`.toLowerCase(),
          isActive: workspace.id === selectedWorkspaceId,
        });
      }
    }
    out.sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
    return out;
  }, [sessionsByWorkspaceId, selectedWorkspaceId, workspaces]);

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

  const handleCreateWorkspace = useCallback(async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    setCreateWorkspaceError(null);
    try {
      const workspaceName = folderNameFromPath(folder);
      const list = await workspaceCreate({
        folderPath: folder,
        name: workspaceName,
        preset,
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      let targetWorkspaceId = createdId;
      let targetWorkspace = list.workspaces.find((workspace) => workspace.id === createdId) ?? null;
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      // Register the workspace with the running openwork-server so
      // listWorkspaces() reflects it immediately. Without this the UI only
      // picks up the new workspace after an app restart (because the server
      // is launched with a fixed --workspace list at boot and the bridge
      // write only updates desktop-side state).
      if (client) {
        const serverList = await client
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .catch(() => null);
        targetWorkspaceId = serverList
          ? resolveWorkspaceListSelectedId(serverList) || serverList.workspaces[serverList.workspaces.length - 1]?.id || targetWorkspaceId
          : targetWorkspaceId;
        targetWorkspace = serverList?.workspaces.find((workspace) => workspace.id === targetWorkspaceId) ?? targetWorkspace;
      }
      setCreateWorkspaceOpen(false);
      // Mark onboarding complete so the /welcome redirect never fires again.
      local.setPrefs((prev) => ({ ...prev, hasCompletedOnboarding: true }));
      await refreshRouteState();
      if (targetWorkspaceId) {
        const workspacePath = targetWorkspace?.path?.trim() || folder;
        const session = baseUrl && token
          ? unwrap(await createClient(
              `${(buildOpenworkWorkspaceBaseUrl(baseUrl, targetWorkspaceId) ?? baseUrl).replace(/\/+$/, "")}/opencode`,
              workspacePath || undefined,
              { token, mode: "openwork" },
            ).session.create({ directory: workspacePath || undefined }))
          : null;
        setLegacySelectedWorkspaceId(targetWorkspaceId);
        writeActiveWorkspaceId(targetWorkspaceId);
        if (session?.id) {
          writeLastSessionFor(targetWorkspaceId, session.id);
          rememberPendingCreatedSession(targetWorkspaceId, session.id);
          setSessionsByWorkspaceId((current) => {
            const next = {
              ...current,
              [targetWorkspaceId]: [session as any, ...(current[targetWorkspaceId] ?? [])],
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
  }, [client, local, navigateToWorkspaceSession, refreshRouteState, rememberPendingCreatedSession]);

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
      const list = await workspaceCreateRemote({
        baseUrl: baseUrlValue,
        openworkHostUrl: baseUrlValue,
        openworkToken: input.openworkToken?.trim() || null,
        displayName: input.displayName?.trim() || null,
        directory: input.directory?.trim() || null,
        remoteType: "openwork",
      });
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
  }, [local, refreshRouteState]);

  return (
    <WorkspaceProvider client={opencodeClient} selectedWorkspaceRoot={selectedWorkspaceRoot}>
    {opencodeClient && selectedWorkspaceEndpoint && opencodeBaseUrl && selectedWorkspaceServerToken ? (
      <ReactSessionRuntime
        // Use the server-side workspace id (the one without the `rem_`
        // prefix) so the React Query cache keys session-sync writes match
        // the keys SessionSurface reads from. Otherwise events arrive but
        // the UI never sees them and gets stuck on "thinking".
        workspaceId={selectedWorkspaceEndpoint.workspaceId}
        sessionId={selectedSessionId}
        opencodeBaseUrl={opencodeBaseUrl}
        openworkToken={selectedWorkspaceServerToken}
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
      openworkServerToken={selectedWorkspaceServerToken}
      developerMode={false}
      headerStatus={canCreateTask ? t("status.connected") : t("session.loading_detail")}
      busyHint={effectiveLoading ? t("session.loading_detail") : null}
      startupPhase={effectiveLoading ? "nativeInit" : "ready"}
      providerConnectedIds={providerConnectedIds}
      providers={providers}
      mcpConnectedCount={0}
      onSendFeedback={() => {
        platform.openLink(
          buildFeedbackUrl({
            entrypoint: "status-bar",
          }),
        );
      }}
      onOpenSettings={() => handleOpenSettings("/settings/general")}
      sidebar={{
        workspaceSessionGroups,
        selectedWorkspaceId,
        selectedSessionId,
        developerMode: false,
        sessionStatusById: {},
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
          if (workspaceId && client) {
            const workspace = workspaces.find((item) => item.id === workspaceId) ?? null;
            const endpoint = endpointForWorkspace(workspace);
            if (endpoint) {
              void endpoint.client.activateWorkspace(endpoint.workspaceId).catch(() => undefined);
            }
          }
          // If we remember what the user last opened here and that session
          // still exists in our local list, navigate. Otherwise stay put.
          const remembered = readLastSessionFor(workspaceId);
          if (remembered && remembered !== selectedSessionId) {
            const known = sessionsByWorkspaceId[workspaceId];
            if (known?.some((session: any) => session?.id === remembered)) {
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
        onCreateTaskInWorkspace: (workspaceId) => {
          void handleCreateTaskInWorkspace(workspaceId);
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
                [workspaceId]: [session as any, ...(current[workspaceId] ?? [])],
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
      todos={[] satisfies TodoItem[]}
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
      statusBar={showPreparingStatus ? {
        statusLabel: "Preparing workspace",
        statusDetail: t("session.loading_detail"),
        statusDotClass: "bg-amber-9",
        statusPingClass: "bg-amber-9/35 animate-ping",
        statusPulse: true,
      } : undefined}
      notFoundMessage={routeNotFoundMessage}
    />
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
      sessions={paletteSessionOptions}
    />
    <ModelPickerModal
      open={modelPickerOpen}
      options={allowedModelOptions}
      query={modelPickerQuery}
      setQuery={setModelPickerQuery}
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
        setModelPickerOpen(false);
      }}
      onBehaviorChange={() => {}}
      onOpenSettings={() => {
        setModelPickerOpen(false);
        handleOpenSettings("/settings/general");
      }}
      onClose={() => setModelPickerOpen(false)}
    />
    </WorkspaceProvider>
  );
}
