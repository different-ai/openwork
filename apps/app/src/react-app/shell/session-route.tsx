/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  writeOpenworkServerSettings,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";
import {
  engineInfo,
  revealDesktopItemInDir,
  openworkServerInfo,
  openworkServerRestart,
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
  SlashCommandOption,
  TodoItem,
  WorkspacePreset,
  WorkspaceConnectionState,
  ProviderListItem,
  WorkspaceSessionGroup,
} from "../../app/types";
import { buildFeedbackUrl } from "../../app/lib/feedback";
import { isDesktopRuntime, isSandboxWorkspace, normalizeDirectoryPath, safeStringify } from "../../app/utils";
import { t } from "../../i18n";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { SessionPage } from "../domains/session/chat/session-page";
import { isDesktopProviderBlocked } from "../../app/cloud/desktop-app-restrictions";
import { useCheckDesktopRestriction } from "../domains/cloud/desktop-config-provider";
import { useRestrictionNotice } from "../domains/cloud/restriction-notice-provider";
import { ReactSessionRuntime } from "../domains/session/sync/runtime-sync";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";
import { RenameWorkspaceModal } from "../domains/workspace/rename-workspace-modal";
import { useShareWorkspaceState } from "../domains/workspace/share-workspace-state";
import { ModelPickerModal } from "../domains/session/modals/model-picker-modal";
import { CommandPalette, type SessionOption as PaletteSessionOption } from "./command-palette";
import { getDisplaySessionTitle } from "../../app/lib/session-title";
import { useBootState } from "./boot-state";
import {
  forgetWorkspaceMemory,
  readActiveWorkspaceId,
  readLastSessionFor,
  writeActiveWorkspaceId,
  writeLastSessionFor,
} from "./session-memory";
import {
  publishInspectorSlice,
  recordInspectorEvent,
} from "./app-inspector";
import { getModelBehaviorSummary } from "../../app/lib/model-behavior";
import { filterProviderList, mapConfigProvidersToList } from "../../app/utils/providers";
import { ensureDesktopLocalOpenworkConnection } from "./desktop-local-openwork";

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

function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

async function resolveRouteOpenworkConnection() {
  const settings = readOpenworkServerSettings();
  let normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
  let resolvedToken = settings.token?.trim() ?? "";
  let hostInfo: OpenworkServerInfo | null = null;

  if (isDesktopRuntime()) {
    try {
      const info = await openworkServerInfo();
      hostInfo = info;
      if (!normalizedBaseUrl) {
        normalizedBaseUrl =
          normalizeOpenworkServerUrl(info.connectUrl ?? info.baseUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
          normalizedBaseUrl;
      }
      if (!resolvedToken) {
        resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || resolvedToken;
      }
    } catch {
      // ignore and fall back to stored settings only
    }
  }

  return { normalizedBaseUrl, resolvedToken, hostInfo };
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

function mergeRouteWorkspaces(
  serverWorkspaces: OpenworkWorkspaceInfo[],
  desktopWorkspaces: RouteWorkspace[],
): RouteWorkspace[] {
  const desktopById = new Map(desktopWorkspaces.map((workspace) => [workspace.id, workspace]));
  const desktopByPath = new Map(
    desktopWorkspaces
      .map((workspace) => [normalizeDirectoryPath(workspace.path ?? ""), workspace] as const)
      .filter(([path]) => path.length > 0),
  );

  const mergedServer = serverWorkspaces.map((workspace) => {
    const match =
      desktopById.get(workspace.id) ??
      desktopByPath.get(normalizeDirectoryPath(workspace.path ?? ""));
    const merged = match
      ? {
          ...workspace,
          displayName: match.displayName?.trim()
            ? match.displayName
            : workspace.displayName,
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
    mergedServer
      .map((workspace) => normalizeDirectoryPath(workspace.path ?? ""))
      .filter((path) => path.length > 0),
  );

  const missingDesktop = desktopWorkspaces.filter((workspace) => {
    if (mergedIds.has(workspace.id)) return false;
    const normalizedPath = normalizeDirectoryPath(workspace.path ?? "");
    if (normalizedPath && mergedPaths.has(normalizedPath)) return false;
    return true;
  });

  return [...mergedServer, ...missingDesktop];
}

function toSessionGroups(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, any[]>,
  errorsByWorkspaceId: Record<string, string | null>,
): WorkspaceSessionGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    sessions: (sessionsByWorkspaceId[workspace.id] ?? []) as WorkspaceSessionGroup["sessions"],
    status: errorsByWorkspaceId[workspace.id] ? "error" : "ready",
    error: errorsByWorkspaceId[workspace.id],
  }));
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

  for (const attachment of draft.attachments) {
    parts.push({
      type: "file",
      url: await fileToDataUrl(attachment.file),
      filename: attachment.name,
      mime: attachment.mimeType,
    });
  }

  return parts;
}

export function SessionRoute() {
  const navigate = useNavigate();
  const platform = usePlatform();
  const local = useLocal();
  const checkDesktopRestriction = useCheckDesktopRestriction();
  const restrictionNotice = useRestrictionNotice();
  const params = useParams<{ sessionId?: string }>();
  const selectedSessionId = params.sessionId?.trim() || null;

  const { markRouteReady: markBootRouteReady } = useBootState();
  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<OpenworkServerClient | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, any[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [routeError, setRouteError] = useState<string | null>(null);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(() => readActiveWorkspaceId() ?? "");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  // One-way latch for "a refreshRouteState is currently running"; prevents
  // overlapping route refreshes from queueing up when the user clicks fast.
  const refreshInFlightRef = useRef(false);
  const workspacesRef = useRef<RouteWorkspace[]>([]);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
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
  const [modelPickerQuery, setModelPickerQuery] = useState("");
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [providers, setProviders] = useState<ProviderListItem[]>([]);
  const [providerConnectedIds, setProviderConnectedIds] = useState<string[]>([]);
  // Provider catalog cache. Used to compute the reasoning/thinking variant
  // options for whichever model is currently selected so the composer's
  // behavior pill actually shows its options (bug: was empty before).
  const [providerCatalog, setProviderCatalog] = useState<Record<string, Record<string, any>>>({});
  const [openworkServerHostInfoState, setOpenworkServerHostInfoState] = useState<OpenworkServerInfo | null>(null);
  const [openworkServerSettingsVersion, setOpenworkServerSettingsVersion] = useState(0);
  const [routeEngineInfo, setRouteEngineInfo] = useState<EngineInfo | null>(null);
  const [shareRemoteAccessBusy, setShareRemoteAccessBusy] = useState(false);
  const [shareRemoteAccessError, setShareRemoteAccessError] = useState<string | null>(null);
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

      const { normalizedBaseUrl, resolvedToken, hostInfo } = await resolveRouteOpenworkConnection();
      setOpenworkServerHostInfoState(hostInfo);
      if (!normalizedBaseUrl || !resolvedToken) {
        setClient(null);
        setBaseUrl("");
        setToken("");
        setWorkspaces(desktopWorkspaces);
        setSessionsByWorkspaceId({});
        setErrorsByWorkspaceId({});
        setSelectedWorkspaceId(resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "");
        return;
      }

      const openworkClient = createOpenworkServerClient({
        baseUrl: normalizedBaseUrl,
        token: resolvedToken,
      });
      const list = await openworkClient.listWorkspaces();
      const nextWorkspaces = mergeRouteWorkspaces(list.items, desktopWorkspaces);

      const sessionEntries = await Promise.all(
        nextWorkspaces.map(async (workspace) => {
          try {
            const response = await openworkClient.listSessions(workspace.id, { limit: 200 });
            // The underlying opencode instance is shared across all local
            // workspaces attached to the same openwork-server, so `listSessions`
            // returns every session it knows about. Filter to just the ones
            // rooted in this workspace's path (match the Solid reference at
            // context/workspace.ts::listWorkspaceSessions).
            const workspaceRoot = normalizeDirectoryPath(workspace.path ?? "");
            const items = workspaceRoot
              ? (response.items ?? []).filter((session: any) =>
                  normalizeDirectoryPath(session?.directory ?? "") === workspaceRoot,
                )
              : (response.items ?? []);
            return { workspaceId: workspace.id, sessions: items, error: null as string | null };
          } catch (error) {
            return {
              workspaceId: workspace.id,
              sessions: [],
              error: error instanceof Error ? error.message : t("app.unknown_error"),
            };
          }
        }),
      );

      // Prefer, in order: the URL-selected workspace (if it owns the session),
      // the user's last-active workspace from localStorage, the desktop's
      // activeId, the server's activeId, then the first known workspace.
      const persistedActiveId = readActiveWorkspaceId();
      let nextWorkspaceId =
        (persistedActiveId && nextWorkspaces.some((w) => w.id === persistedActiveId)
          ? persistedActiveId
          : "") ||
        resolveWorkspaceListSelectedId(desktopList) ||
        list.activeId?.trim() ||
        nextWorkspaces[0]?.id ||
        "";
      if (selectedSessionId) {
        const match = sessionEntries.find((entry) =>
          entry.sessions.some((session) => session.id === selectedSessionId),
        );
        if (match?.workspaceId) nextWorkspaceId = match.workspaceId;
      }

      setClient(openworkClient);
      setBaseUrl(normalizedBaseUrl);
      setToken(resolvedToken);
      setWorkspaces(nextWorkspaces);
      setSessionsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.sessions])));
      setErrorsByWorkspaceId(Object.fromEntries(sessionEntries.map((entry) => [entry.workspaceId, entry.error])));
      setSelectedWorkspaceId(nextWorkspaceId);
      writeActiveWorkspaceId(nextWorkspaceId || null);
      recordInspectorEvent("route.refresh.complete", {
        workspaces: nextWorkspaces.length,
        selectedWorkspaceId: nextWorkspaceId,
        errors: Object.fromEntries(sessionEntries.filter((e) => e.error).map((e) => [e.workspaceId, e.error])),
      });
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
        setWorkspaces(desktopWorkspaces);
        setSelectedWorkspaceId((current) =>
          current || resolveWorkspaceListSelectedId(desktopList) || desktopWorkspaces[0]?.id || "",
        );
      }
    } finally {
      setLoading(false);
      refreshInFlightRef.current = false;
      // Tell the boot overlay the first route data load has completed so
      // the overlay dismisses after BOTH the desktop boot and the workspace
      // list/sessions are ready.
      markBootRouteReady();
    }
  }, [markBootRouteReady, selectedSessionId]);

  useEffect(() => {
    workspacesRef.current = workspaces;
  }, [workspaces]);

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
    if (selectedSessionId) return;
    if (!selectedWorkspaceId) return;
    const remembered = readLastSessionFor(selectedWorkspaceId);
    if (!remembered) return;
    const sessions = sessionsByWorkspaceId[selectedWorkspaceId] ?? [];
    if (!sessions.some((session: any) => session?.id === remembered)) return;
    navigate(`/session/${remembered}`, { replace: true });
  }, [loading, navigate, selectedSessionId, selectedWorkspaceId, sessionsByWorkspaceId]);

  // NOTE: Blueprint seeding was removed from the route.
  // It was firing `materializeBlueprintSessions` + a session re-fetch on every
  // workspace change, which cascaded setState updates and froze the UI after
  // a few rapid switches. Empty workspaces now simply show "No tasks yet." and
  // the user creates their first session explicitly via "New task". Seeding
  // can be reintroduced later as a one-shot triggered from a button or from
  // the onboarding flow, not from the route effect loop.

  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

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
  const opencodeBaseUrl = useMemo(() => {
    if (!selectedWorkspaceId || !baseUrl) return "";
    const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, selectedWorkspaceId) ?? baseUrl;
    return `${mounted.replace(/\/+$|\/+$/g, "")}/opencode`;
  }, [baseUrl, selectedWorkspaceId]);

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && token
        ? createClient(opencodeBaseUrl, selectedWorkspaceRoot || undefined, {
            token,
            mode: "openwork",
          })
        : null,
    [opencodeBaseUrl, selectedWorkspaceRoot, token],
  );

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
  const { modelVariantLabel, modelBehaviorOptions } = useMemo(() => {
    const ref = local.prefs.defaultModel;
    const variant = local.prefs.modelVariant ?? null;
    if (!ref) {
      return { modelVariantLabel: t("settings.default_label"), modelBehaviorOptions: [] as { value: string | null; label: string }[] };
    }
    const model = providerCatalog[ref.providerID]?.[ref.modelID];
    if (!model) {
      return { modelVariantLabel: variant ?? t("settings.default_label"), modelBehaviorOptions: [] as { value: string | null; label: string }[] };
    }
    const summary = getModelBehaviorSummary(ref.providerID, model, variant);
    return { modelVariantLabel: summary.label, modelBehaviorOptions: summary.options };
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

    return {
      client,
      workspaceId: selectedWorkspaceId,
      workspaceRoot: selectedWorkspaceRoot,
      sessionId: selectedSessionId,
      opencodeBaseUrl,
      openworkToken: token,
      developerMode: false,
      modelLabel,
      onModelClick: () => {
        setModelPickerQuery("");
        setModelPickerOpen(true);
      },
      onOpenSettingsSection: (section: "commands" | "skills" | "mcps") => {
        navigate(section === "skills" ? "/settings/skills" : section === "mcps" ? "/settings/mcp" : "/settings/general");
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
            throw new Error(result.error instanceof Error ? result.error.message : String(result.error));
          }
          return;
        }

        const parts = await draftToParts(draft, selectedWorkspaceRoot);
        const result = await opencodeClient.session.promptAsync({
          sessionID: selectedSessionId,
          parts,
          model: local.prefs.defaultModel ?? undefined,
          agent: selectedAgent ?? undefined,
          ...(local.prefs.modelVariant ? { variant: local.prefs.modelVariant } : {}),
        });
        if (result.error) {
          throw new Error(result.error instanceof Error ? result.error.message : String(result.error));
        }
      },
      onDraftChange: () => {
        // Draft persistence will be wired once the full React shell owns session state.
      },
      attachmentsEnabled: true,
      attachmentsDisabledReason: null,
      modelVariantLabel,
      modelVariant: local.prefs.modelVariant ?? null,
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
      listCommands: async (): Promise<SlashCommandOption[]> => {
        const list = await listCommands(opencodeClient, selectedWorkspaceRoot || undefined);
        return list;
      },
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
    };
  }, [
    client,
    local,
    modelLabel,
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
      if (shareRemoteAccessBusy || !isDesktopRuntime()) return;
      const previous = readOpenworkServerSettings();
      const next = { ...previous, remoteAccessEnabled: enabled };
      setShareRemoteAccessBusy(true);
      setShareRemoteAccessError(null);
      writeOpenworkServerSettings(next);
      setOpenworkServerSettingsVersion((value) => value + 1);
      try {
        const info = await openworkServerRestart({ remoteAccessEnabled: enabled });
        setOpenworkServerHostInfoState(info);
        await refreshRouteState();
      } catch (error) {
        writeOpenworkServerSettings(previous);
        setOpenworkServerSettingsVersion((value) => value + 1);
        setShareRemoteAccessError(error instanceof Error ? error.message : t("app.error_remote_access"));
      } finally {
        setShareRemoteAccessBusy(false);
      }
    },
    [refreshRouteState, shareRemoteAccessBusy],
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
        setSelectedWorkspaceId("");
        writeActiveWorkspaceId(null);
        navigate("/session");
      }
      forgetWorkspaceMemory(workspaceId);
      await refreshRouteState();
    },
    [client, navigate, refreshRouteState, selectedWorkspaceId],
  );

  const handleCreateTaskInWorkspace = useCallback(async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || !token || !baseUrl) return;
    const workspaceOpencodeBaseUrl = `${(buildOpenworkWorkspaceBaseUrl(baseUrl, workspace.id) ?? baseUrl).replace(/\/+$|\/+$/g, "")}/opencode`;
    const workspaceClient = createClient(
      workspaceOpencodeBaseUrl,
      workspace.path?.trim() || undefined,
      { token, mode: "openwork" },
    );
    const session = unwrap(
      await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
    );
    navigate(`/session/${session.id}`);
  }, [baseUrl, navigate, token, workspaces]);

  // Global shortcuts:
  //   Cmd/Ctrl+N  -> new task in selected workspace
  //   Cmd/Ctrl+K  -> toggle command palette
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
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
        if (selectedWorkspaceId) {
          void handleCreateTaskInWorkspace(selectedWorkspaceId);
        }
        return;
      }
      if (key === "k") {
        event.preventDefault();
        setCommandPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleCreateTaskInWorkspace, selectedWorkspaceId]);

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

  const handleCreateWorkspace = useCallback(async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    try {
      const workspaceName = folderNameFromPath(folder);
      const list = await workspaceCreate({
        folderPath: folder,
        name: workspaceName,
        preset,
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
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
        await client
          .createLocalWorkspace({ folderPath: folder, name: workspaceName, preset })
          .catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
      if (createdId) {
        navigate("/settings/general");
      }
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [client, navigate, refreshRouteState]);

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
      await refreshRouteState();
      return true;
    } catch (error) {
      setCreateWorkspaceRemoteError(error instanceof Error ? error.message : t("app.unknown_error"));
      return false;
    } finally {
      setCreateWorkspaceRemoteBusy(false);
    }
  }, [refreshRouteState]);

  return (
    <>
    {selectedWorkspaceId && opencodeBaseUrl && token ? (
      <ReactSessionRuntime
        workspaceId={selectedWorkspaceId}
        sessionId={selectedSessionId}
        opencodeBaseUrl={opencodeBaseUrl}
        openworkToken={token}
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
      runtimeWorkspaceId={selectedWorkspaceId || null}
      workspaces={workspaces}
      clientConnected={Boolean(opencodeClient)}
      openworkServerStatus={client ? "connected" : "disconnected"}
      openworkServerClient={client}
      openworkServerToken={token}
      developerMode={false}
      headerStatus={client ? t("status.connected") : t("status.disconnected_label")}
      busyHint={loading ? t("session.loading_detail") : null}
      startupPhase={loading ? "nativeInit" : "ready"}
      providerConnectedIds={providerConnectedIds}
      providers={providers}
      mcpConnectedCount={0}
      onSendFeedback={() => {
        platform.openLink(
          buildFeedbackUrl({
            entrypoint: "status-bar",
            appVersion: "0.11.207",
          }),
        );
      }}
      onOpenSettings={() => navigate("/settings/general")}
      sidebar={{
        workspaceSessionGroups,
        selectedWorkspaceId,
        selectedSessionId,
        developerMode: false,
        sessionStatusById: {},
        connectingWorkspaceId: null,
        workspaceConnectionStateById: {},
        newTaskDisabled: !Boolean(opencodeClient),
        sidebarHydratedFromCache: false,
        startupPhase: loading ? "nativeInit" : "ready",
        onSelectWorkspace: async (workspaceId) => {
          if (workspaceId === selectedWorkspaceId) return true;
          setSelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          // Fire Tauri updates but don't await them — they're bookkeeping and
          // awaiting 2 IPC roundtrips on every click used to stall rapid
          // workspace switches behind a queue.
          if (isDesktopRuntime()) {
            void workspaceSetSelected(workspaceId).catch(() => undefined);
            void workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
          }
          // If we remember what the user last opened here and that session
          // still exists in our local list, navigate. Otherwise stay put.
          const remembered = readLastSessionFor(workspaceId);
          if (remembered && remembered !== selectedSessionId) {
            const known = sessionsByWorkspaceId[workspaceId];
            if (known?.some((session: any) => session?.id === remembered)) {
              navigate(`/session/${remembered}`);
            }
          }
          return true;
        },
        onOpenSession: (workspaceId, sessionId) => {
          setSelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, sessionId);
          navigate(`/session/${sessionId}`);
        },
        onPrefetchSession: () => {},
        onCreateTaskInWorkspace: async (workspaceId) => {
          const workspace = workspaces.find((item) => item.id === workspaceId);
          if (!workspace || !token || !baseUrl) return;
          const workspaceOpencodeBaseUrl = `${(buildOpenworkWorkspaceBaseUrl(baseUrl, workspace.id) ?? baseUrl).replace(/\/+$|\/+$/g, "")}/opencode`;
          const workspaceClient = createClient(
            workspaceOpencodeBaseUrl,
            workspace.path?.trim() || undefined,
            { token, mode: "openwork" },
          );
          const session = unwrap(
            await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
          );
          // Make sure the new session is the active pair before navigating
          // so the surface renders the new id immediately instead of going
          // through the "unknown session" render tick.
          setSelectedWorkspaceId(workspaceId);
          writeActiveWorkspaceId(workspaceId || null);
          writeLastSessionFor(workspaceId, session.id);
          setSessionsByWorkspaceId((current) => ({
            ...current,
            [workspaceId]: [session as any, ...(current[workspaceId] ?? [])],
          }));
          navigate(`/session/${session.id}`);
          // Refresh in the background so the new session picks up its real
          // metadata (title, timestamps) as soon as the server knows them.
          void refreshRouteState();
        },
        onOpenRenameWorkspace: handleOpenRenameWorkspace,
        onShareWorkspace: handleShareWorkspace,
        onRevealWorkspace: (id) => void handleRevealWorkspace(id),
        onRecoverWorkspace: async () => false,
        onTestWorkspaceConnection: async () => true,
        onEditWorkspaceConnection: () => {},
        onForgetWorkspace: (id) => void handleForgetWorkspace(id),
        onOpenCreateWorkspace: handleOpenCreateWorkspace,
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
      sessionLoadingById={(sessionId) => loading && Boolean(sessionId && sessionId === selectedSessionId)}
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
                      busy: shareRemoteAccessBusy,
                      error: shareRemoteAccessError,
                      onSave: handleSaveShareRemoteAccess,
                    }
                  : undefined,
              note: shareWorkspaceState.shareNote,
              onShareWorkspaceProfile: () => void shareWorkspaceState.publishWorkspaceProfileLink(),
              shareWorkspaceProfileBusy: shareWorkspaceState.shareWorkspaceProfileBusy,
              shareWorkspaceProfileUrl: shareWorkspaceState.shareWorkspaceProfileUrl,
              shareWorkspaceProfileError: shareWorkspaceState.shareWorkspaceProfileError,
              shareWorkspaceProfileDisabledReason: shareWorkspaceState.shareServiceDisabledReason,
              shareWorkspaceProfileSensitiveWarnings:
                shareWorkspaceState.shareWorkspaceProfileSensitiveWarnings,
              shareWorkspaceProfileSensitiveMode:
                shareWorkspaceState.shareWorkspaceProfileSensitiveMode,
              onShareWorkspaceProfileSensitiveModeChange:
                shareWorkspaceState.setShareWorkspaceProfileSensitiveMode,
              onShareWorkspaceProfileToTeam: (name) =>
                void shareWorkspaceState.shareWorkspaceProfileToTeam(name),
              shareWorkspaceProfileToTeamBusy:
                shareWorkspaceState.shareWorkspaceProfileTeamBusy,
              shareWorkspaceProfileToTeamError:
                shareWorkspaceState.shareWorkspaceProfileTeamError,
              shareWorkspaceProfileToTeamSuccess:
                shareWorkspaceState.shareWorkspaceProfileTeamSuccess,
              shareWorkspaceProfileToTeamDisabledReason:
                shareWorkspaceState.shareWorkspaceProfileTeamDisabledReason,
              shareWorkspaceProfileToTeamOrgName:
                shareWorkspaceState.shareWorkspaceProfileTeamOrgName,
              shareWorkspaceProfileToTeamNeedsSignIn:
                shareWorkspaceState.shareWorkspaceProfileToTeamNeedsSignIn,
              onShareWorkspaceProfileToTeamSignIn:
                shareWorkspaceState.startShareWorkspaceProfileToTeamSignIn,
              templateContentSummary: {
                skillNames: [],
                commandNames: [],
                configFiles: ["opencode.json", "openwork.json"],
              },
              onShareSkillsSet: () => void shareWorkspaceState.publishSkillsSetLink(),
              shareSkillsSetBusy: shareWorkspaceState.shareSkillsSetBusy,
              shareSkillsSetUrl: shareWorkspaceState.shareSkillsSetUrl,
              shareSkillsSetError: shareWorkspaceState.shareSkillsSetError,
              shareSkillsSetDisabledReason: shareWorkspaceState.shareServiceDisabledReason,
              onExportConfig:
                shareWorkspaceState.exportDisabledReason === null
                  ? () => {
                      const id = shareWorkspaceState.shareWorkspaceId;
                      if (!id) return;
                      void handleExportWorkspaceConfig(id);
                    }
                  : undefined,
              exportDisabledReason: shareWorkspaceState.exportDisabledReason,
              onOpenBots: () => navigate("/settings/messaging"),
            }
          : null
      }
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
              await client.deleteSession(selectedWorkspaceId, sessionId);
              if (selectedSessionId === sessionId) {
                navigate("/session");
              }
              await refreshRouteState();
            }
          : undefined
      }
    />
    <CreateWorkspaceModal
      open={createWorkspaceOpen}
      onClose={() => setCreateWorkspaceOpen(false)}
      onConfirm={handleCreateWorkspace}
      onConfirmRemote={handleCreateRemoteWorkspace}
      onPickFolder={() => pickDirectory({ title: t("onboarding.authorize_folder") }) as Promise<string | null>}
      submitting={createWorkspaceBusy}
      remoteSubmitting={createWorkspaceRemoteBusy}
      remoteError={createWorkspaceRemoteError}
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
      onOpenSession={(_workspaceId, sessionId) => navigate(`/session/${sessionId}`)}
      onOpenSettings={(route) => navigate(route ?? "/settings/general")}
      sessions={paletteSessionOptions}
    />
    <ModelPickerModal
      open={modelPickerOpen}
      options={allowedModelOptions}
      filteredOptions={allowedModelOptions.filter((opt) => {
        const q = modelPickerQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          opt.title.toLowerCase().includes(q) ||
          opt.providerID.toLowerCase().includes(q) ||
          opt.modelID.toLowerCase().includes(q)
        );
      })}
      query={modelPickerQuery}
      setQuery={setModelPickerQuery}
      target="default"
      current={local.prefs.defaultModel ?? ({ providerID: "", modelID: "" } satisfies ModelRef)}
      onSelect={(next: ModelRef) => {
        local.setPrefs((previous) => ({ ...previous, defaultModel: next }));
        setModelPickerOpen(false);
      }}
      onBehaviorChange={() => {}}
      onOpenSettings={() => {
        setModelPickerOpen(false);
        navigate("/settings/general");
      }}
      onClose={() => setModelPickerOpen(false)}
    />
    </>
  );
}
