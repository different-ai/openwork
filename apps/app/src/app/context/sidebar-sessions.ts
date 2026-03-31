import { createEffect, createMemo, createSignal } from "solid-js";

import type { Session } from "@opencode-ai/sdk/v2/client";

import { createClient, type OpencodeAuth, unwrap } from "../lib/opencode";
import type { WorkspaceInfo, EngineInfo } from "../lib/tauri";
import type { SidebarSessionItem, WorkspaceSessionGroup } from "../types";
import {
  normalizeDirectoryPath,
  safeStringify,
} from "../utils";
import { toSessionTransportDirectory } from "../lib/session-scope";

const sessionActivity = (session: Session) =>
  session.time?.updated ?? session.time?.created ?? 0;

const sortSessionsByActivity = (list: Session[]) =>
  list
    .slice()
    .sort((a, b) => {
      const delta = sessionActivity(b) - sessionActivity(a);
      if (delta !== 0) return delta;
      return a.id.localeCompare(b.id);
    });

type SidebarWorkspaceSessionsStatus = WorkspaceSessionGroup["status"];

export function createSidebarSessionsStore(options: {
  workspaces: () => WorkspaceInfo[];
  engine: () => EngineInfo | null;
}) {
  const [sessionsByWorkspaceId, setSessionsByWorkspaceId] = createSignal<
    Record<string, SidebarSessionItem[]>
  >({});
  const [statusByWorkspaceId, setStatusByWorkspaceId] = createSignal<
    Record<string, SidebarWorkspaceSessionsStatus>
  >({});
  const [errorByWorkspaceId, setErrorByWorkspaceId] = createSignal<Record<string, string | null>>({});

  const pruneState = (workspaceIds: Set<string>) => {
    setSessionsByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarSessionItem[]> = {};
      for (const [id, list] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = list;
      }
      return changed ? next : prev;
    });
    setStatusByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, SidebarWorkspaceSessionsStatus> = {};
      for (const [id, status] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = status;
      }
      return changed ? next : prev;
    });
    setErrorByWorkspaceId((prev) => {
      let changed = false;
      const next: Record<string, string | null> = {};
      for (const [id, error] of Object.entries(prev)) {
        if (!workspaceIds.has(id)) {
          changed = true;
          continue;
        }
        next[id] = error;
      }
      return changed ? next : prev;
    });
  };

  const resolveClientConfig = (workspaceId: string) => {
    const workspace = options.workspaces().find((entry) => entry.id === workspaceId) ?? null;
    if (!workspace) return null;

    if (workspace.workspaceType === "local") {
      const info = options.engine();
      const baseUrl = info?.baseUrl?.trim() ?? "";
      const directory = toSessionTransportDirectory(workspace.path?.trim() ?? "");
      const username = info?.opencodeUsername?.trim() ?? "";
      const password = info?.opencodePassword?.trim() ?? "";
      const auth: OpencodeAuth | undefined = username && password ? { username, password } : undefined;
      return { baseUrl, directory, auth };
    }

    const baseUrl = workspace.baseUrl?.trim() ?? "";
    const directory = workspace.directory?.trim() ?? "";
    if (workspace.remoteType === "openwork") {
      const token = workspace.openworkToken?.trim() ?? "";
      const auth: OpencodeAuth | undefined = token ? { token, mode: "openwork" } : undefined;
      return { baseUrl, directory, auth };
    }

    return {
      baseUrl,
      directory,
      auth: undefined as OpencodeAuth | undefined,
    };
  };

  const refreshSeqByWorkspaceId: Record<string, number> = {};
  const SIDEBAR_SESSION_LIMIT = 200;

  const refreshWorkspaceSessions = async (workspaceId: string) => {
    const id = workspaceId.trim();
    if (!id) return;

    const config = resolveClientConfig(id);
    if (!config) return;

    if (!config.baseUrl) {
      setStatusByWorkspaceId((prev) => (prev[id] === "idle" ? prev : { ...prev, [id]: "idle" }));
      setErrorByWorkspaceId((prev) => ((prev[id] ?? null) === null ? prev : { ...prev, [id]: null }));
      return;
    }

    refreshSeqByWorkspaceId[id] = (refreshSeqByWorkspaceId[id] ?? 0) + 1;
    const seq = refreshSeqByWorkspaceId[id];

    setStatusByWorkspaceId((prev) => ({ ...prev, [id]: "loading" }));
    setErrorByWorkspaceId((prev) => ({ ...prev, [id]: null }));

    try {
      let directory = config.directory;
      let client = createClient(config.baseUrl, directory || undefined, config.auth);

      if (!directory) {
        try {
          const pathInfo = unwrap(await client.path.get());
          const discovered = toSessionTransportDirectory(pathInfo.directory ?? "");
          if (discovered) {
            directory = discovered;
            client = createClient(config.baseUrl, directory, config.auth);
          }
        } catch {
          // Ignore discovery failures and continue with the configured directory.
        }
      }

      const queryDirectory = toSessionTransportDirectory(directory) || undefined;
      const list = unwrap(
        await client.session.list({ directory: queryDirectory, roots: false, limit: SIDEBAR_SESSION_LIMIT }),
      );
      if (refreshSeqByWorkspaceId[id] !== seq) return;

      const root = normalizeDirectoryPath(directory);
      const filtered = root ? list.filter((session) => normalizeDirectoryPath(session.directory) === root) : list;
      const sorted = sortSessionsByActivity(filtered);
      const items: SidebarSessionItem[] = sorted.map((session) => ({
        id: session.id,
        title: session.title,
        slug: session.slug,
        parentID: session.parentID,
        time: session.time,
        directory: session.directory,
      }));

      setSessionsByWorkspaceId((prev) => ({
        ...prev,
        [id]: items,
      }));
      setStatusByWorkspaceId((prev) => ({ ...prev, [id]: "ready" }));
    } catch (error) {
      if (refreshSeqByWorkspaceId[id] !== seq) return;
      const message = error instanceof Error ? error.message : safeStringify(error);
      setStatusByWorkspaceId((prev) => ({ ...prev, [id]: "error" }));
      setErrorByWorkspaceId((prev) => ({ ...prev, [id]: message }));
    }
  };

  let lastFingerprintByWorkspaceId: Record<string, string> = {};
  createEffect(() => {
    const engineInfo = options.engine();
    const engineBaseUrl = engineInfo?.baseUrl?.trim() ?? "";
    const engineUser = engineInfo?.opencodeUsername?.trim() ?? "";
    const enginePass = engineInfo?.opencodePassword?.trim() ?? "";
    const workspaces = options.workspaces();
    const workspaceIds = new Set(workspaces.map((workspace) => workspace.id));
    pruneState(workspaceIds);

    const nextFingerprintByWorkspaceId: Record<string, string> = {};
    for (const workspace of workspaces) {
      const root = workspace.workspaceType === "local" ? workspace.path?.trim() ?? "" : workspace.directory?.trim() ?? "";
      const base = workspace.workspaceType === "local" ? engineBaseUrl : workspace.baseUrl?.trim() ?? "";
      const remoteType = workspace.workspaceType === "remote" ? (workspace.remoteType ?? "") : "";
      const token = workspace.remoteType === "openwork" ? (workspace.openworkToken?.trim() ?? "") : "";
      const authKey = workspace.workspaceType === "local" ? `${engineUser}:${enginePass}` : token;
      nextFingerprintByWorkspaceId[workspace.id] = [workspace.workspaceType, remoteType, root, base, authKey].join("|");
    }

    for (const workspace of workspaces) {
      const nextFingerprint = nextFingerprintByWorkspaceId[workspace.id];
      if (lastFingerprintByWorkspaceId[workspace.id] === nextFingerprint) continue;
      void refreshWorkspaceSessions(workspace.id).catch(() => undefined);
    }

    lastFingerprintByWorkspaceId = nextFingerprintByWorkspaceId;
  });

  const workspaceGroups = createMemo<WorkspaceSessionGroup[]>(() => {
    const workspaces = options.workspaces();
    const sessions = sessionsByWorkspaceId();
    const statuses = statusByWorkspaceId();
    const errors = errorByWorkspaceId();
    return workspaces.map((workspace) => ({
      workspace,
      sessions: sessions[workspace.id] ?? [],
      status: statuses[workspace.id] ?? "idle",
      error: errors[workspace.id] ?? null,
    }));
  });

  return {
    workspaceGroups,
    refreshWorkspaceSessions,
  };
}
