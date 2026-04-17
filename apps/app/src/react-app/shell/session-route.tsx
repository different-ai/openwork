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
import type {
  ComposerAttachment,
  ComposerDraft,
  ComposerPart,
  SlashCommandOption,
  TodoItem,
  WorkspaceConnectionState,
  WorkspaceSessionGroup,
} from "../../app/types";
import { createClient } from "../../app/lib/opencode";
import { isSandboxWorkspace } from "../../app/utils";
import { t } from "../../i18n";
import { useLocal } from "../kernel/local-provider";
import { usePlatform } from "../kernel/platform";
import { SessionPage } from "../domains/session/chat/session-page";

type RouteWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved: string;
};

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

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      setLoading(true);
      try {
        const settings = readOpenworkServerSettings();
        const normalizedBaseUrl = normalizeOpenworkServerUrl(settings.urlOverride ?? "") ?? "";
        const resolvedToken = settings.token?.trim() ?? "";
        if (!normalizedBaseUrl || !resolvedToken) {
          if (!cancelled) {
            setClient(null);
            setBaseUrl("");
            setToken("");
            setWorkspaces([]);
            setSessionsByWorkspaceId({});
            setErrorsByWorkspaceId({});
            setSelectedWorkspaceId("");
          }
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

        const sessionEntries = await Promise.all(
          routeWorkspaces.map(async (workspace) => {
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

        if (cancelled) return;

        const nextSessionsByWorkspaceId = Object.fromEntries(
          sessionEntries.map((entry) => [entry.workspaceId, entry.sessions]),
        );
        const nextErrorsByWorkspaceId = Object.fromEntries(
          sessionEntries.map((entry) => [entry.workspaceId, entry.error]),
        );

        let nextWorkspaceId = list.activeId?.trim() || routeWorkspaces[0]?.id || "";
        if (selectedSessionId) {
          const match = sessionEntries.find((entry) =>
            entry.sessions.some((session) => session.id === selectedSessionId),
          );
          if (match?.workspaceId) {
            nextWorkspaceId = match.workspaceId;
          }
        }

        setClient(openworkClient);
        setBaseUrl(normalizedBaseUrl);
        setToken(resolvedToken);
        setWorkspaces(routeWorkspaces);
        setSessionsByWorkspaceId(nextSessionsByWorkspaceId);
        setErrorsByWorkspaceId(nextErrorsByWorkspaceId);
        setSelectedWorkspaceId(nextWorkspaceId);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selectedSessionId]);

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

  return (
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
        onOpenCreateWorkspace: () => navigate("/settings/general"),
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
  );
}
