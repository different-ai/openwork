/** @jsxImportSource react */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import type { AgentPartInput, FilePartInput, TextPartInput } from "@opencode-ai/sdk/v2/client";

import { unwrap } from "../../app/lib/opencode";
import { listCommands, shellInSession } from "../../app/lib/opencode-session";
import {
  buildOpenworkWorkspaceBaseUrl,
  createOpenworkServerClient,
  normalizeOpenworkServerUrl,
  readOpenworkServerSettings,
  type OpenworkServerClient,
  type OpenworkWorkspaceInfo,
} from "../../app/lib/openwork-server";
import {
  openworkServerInfo,
  pickDirectory,
  resolveWorkspaceListSelectedId,
  workspaceBootstrap,
  workspaceCreate,
  workspaceCreateRemote,
  workspaceSetRuntimeActive,
  workspaceSetSelected,
  type WorkspaceInfo,
  type WorkspaceList,
} from "../../app/lib/tauri";
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  SlashCommandOption,
  TodoItem,
  WorkspacePreset,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../app/types";
import { createClient } from "../../app/lib/opencode";
import { isSandboxWorkspace, isTauriRuntime } from "../../app/utils";
import { t } from "../../i18n";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { SessionPage } from "../domains/session/chat/session-page";
import { CreateWorkspaceModal } from "../domains/workspace/create-workspace-modal";

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

  if ((!normalizedBaseUrl || !resolvedToken) && isTauriRuntime()) {
    try {
      const info = await openworkServerInfo();
      normalizedBaseUrl =
        normalizeOpenworkServerUrl(info.connectUrl ?? info.baseUrl ?? info.lanUrl ?? info.mdnsUrl ?? "") ??
        normalizedBaseUrl;
      resolvedToken = info.ownerToken?.trim() || info.clientToken?.trim() || resolvedToken;
    } catch {
      // ignore and fall back to stored settings only
    }
  }

  return { normalizedBaseUrl, resolvedToken };
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
  const params = useParams<{ sessionId?: string }>();
  const selectedSessionId = params.sessionId?.trim() || null;

  const [loading, setLoading] = useState(true);
  const [client, setClient] = useState<OpenworkServerClient | null>(null);
  const [baseUrl, setBaseUrl] = useState("");
  const [token, setToken] = useState("");
  const [workspaces, setWorkspaces] = useState<RouteWorkspace[]>([]);
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = useState<Record<string, any[]>>({});
  const [errorsByWorkspaceId, setErrorsByWorkspaceId] = useState<Record<string, string | null>>({});
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [createWorkspaceOpen, setCreateWorkspaceOpen] = useState(false);
  const [createWorkspaceBusy, setCreateWorkspaceBusy] = useState(false);
  const [createWorkspaceRemoteBusy, setCreateWorkspaceRemoteBusy] = useState(false);
  const [createWorkspaceRemoteError, setCreateWorkspaceRemoteError] = useState<string | null>(null);

  const refreshRouteState = useCallback(async () => {
    setLoading(true);
    try {
      const desktopList = isTauriRuntime() ? await workspaceBootstrap().catch(() => null) : null;
      const desktopWorkspaces = (desktopList?.workspaces ?? []).map(mapDesktopWorkspace);

      const { normalizedBaseUrl, resolvedToken } = await resolveRouteOpenworkConnection();
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
      const routeWorkspaces = list.items.map((workspace) => ({
        ...workspace,
        displayNameResolved: workspaceLabel(workspace),
      }));
      const nextWorkspaces = desktopWorkspaces.length > 0 ? desktopWorkspaces : routeWorkspaces;

      const sessionEntries = await Promise.all(
        nextWorkspaces.map(async (workspace) => {
          try {
            const response = await openworkClient.listSessions(workspace.id, { limit: 100 });
            return { workspaceId: workspace.id, sessions: response.items, error: null as string | null };
          } catch (error) {
            return {
              workspaceId: workspace.id,
              sessions: [],
              error: error instanceof Error ? error.message : t("app.unknown_error"),
            };
          }
        }),
      );

      let nextWorkspaceId =
        resolveWorkspaceListSelectedId(desktopList) || list.activeId?.trim() || nextWorkspaces[0]?.id || "";
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
    } finally {
      setLoading(false);
    }
  }, [selectedSessionId]);

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

    return () => {
      cancelled = true;
    };
  }, [refreshRouteState]);

  const workspaceSessionGroups = useMemo(
    () => toSessionGroups(workspaces, sessionsByWorkspaceId, errorsByWorkspaceId),
    [errorsByWorkspaceId, sessionsByWorkspaceId, workspaces],
  );

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? workspaces[0] ?? null,
    [selectedWorkspaceId, workspaces],
  );

  const selectedWorkspaceRoot = selectedWorkspace?.path?.trim() || "";
  const opencodeBaseUrl = useMemo(() => {
    if (!selectedWorkspaceId || !baseUrl) return "";
    const mounted = buildOpenworkWorkspaceBaseUrl(baseUrl, selectedWorkspaceId) ?? baseUrl;
    return `${mounted.replace(/\/+$|\/+$/g, "")}/opencode`;
  }, [baseUrl, selectedWorkspaceId]);

  const opencodeClient = useMemo(
    () =>
      opencodeBaseUrl && token
        ? createClient(opencodeBaseUrl, undefined, { token, mode: "openwork" })
        : null,
    [opencodeBaseUrl, token],
  );

  const modelLabel = local.prefs.defaultModel
    ? `${local.prefs.defaultModel.providerID}/${local.prefs.defaultModel.modelID}`
    : t("session.default_model");

  const surfaceProps = useMemo(() => {
    if (!client || !selectedWorkspaceId || !selectedSessionId || !opencodeBaseUrl || !token || !opencodeClient) {
      return null;
    }

    return {
      client,
      workspaceId: selectedWorkspaceId,
      sessionId: selectedSessionId,
      opencodeBaseUrl,
      openworkToken: token,
      developerMode: false,
      modelLabel,
      onModelClick: () => navigate("/settings/general"),
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
      modelVariantLabel: local.prefs.modelVariant ?? t("settings.default_label"),
      modelVariant: local.prefs.modelVariant,
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
    token,
  ]);

  const handleOpenCreateWorkspace = useCallback(() => {
    setCreateWorkspaceRemoteError(null);
    setCreateWorkspaceOpen(true);
  }, []);

  const handleCreateWorkspace = useCallback(async (preset: WorkspacePreset, folder: string | null) => {
    if (!folder) return;
    setCreateWorkspaceBusy(true);
    try {
      const list = await workspaceCreate({
        folderPath: folder,
        name: folderNameFromPath(folder),
        preset,
      });
      const createdId = resolveWorkspaceListSelectedId(list) || list.workspaces[list.workspaces.length - 1]?.id || "";
      if (createdId) {
        await workspaceSetSelected(createdId).catch(() => undefined);
        await workspaceSetRuntimeActive(createdId).catch(() => undefined);
      }
      setCreateWorkspaceOpen(false);
      await refreshRouteState();
      if (createdId) {
        navigate("/settings/general");
      }
    } finally {
      setCreateWorkspaceBusy(false);
    }
  }, [navigate, refreshRouteState]);

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
      providerConnectedIds={[]}
      providers={[]}
      mcpConnectedCount={0}
      onSendFeedback={() => {
        platform.openLink("https://openworklabs.com/docs");
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
          if (isTauriRuntime()) {
            await workspaceSetSelected(workspaceId).catch(() => undefined);
            await workspaceSetRuntimeActive(workspaceId).catch(() => undefined);
          }
          setSelectedWorkspaceId(workspaceId);
          return true;
        },
        onOpenSession: (workspaceId, sessionId) => {
          setSelectedWorkspaceId(workspaceId);
          navigate(`/session/${sessionId}`);
        },
        onPrefetchSession: () => {},
        onCreateTaskInWorkspace: async (workspaceId) => {
          const workspace = workspaces.find((item) => item.id === workspaceId);
          if (!workspace || !token || !baseUrl) return;
          const workspaceOpencodeBaseUrl = `${(buildOpenworkWorkspaceBaseUrl(baseUrl, workspace.id) ?? baseUrl).replace(/\/+$|\/+$/g, "")}/opencode`;
          const workspaceClient = createClient(workspaceOpencodeBaseUrl, undefined, { token, mode: "openwork" });
          const session = unwrap(
            await workspaceClient.session.create({ directory: workspace.path?.trim() || undefined }),
          );
          navigate(`/session/${session.id}`);
        },
        onOpenRenameWorkspace: () => {},
        onShareWorkspace: () => {},
        onRevealWorkspace: () => {},
        onRecoverWorkspace: async () => false,
        onTestWorkspaceConnection: async () => true,
        onEditWorkspaceConnection: () => {},
        onForgetWorkspace: () => {},
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
    </>
  );
}
