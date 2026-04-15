import { HTTPException } from "hono/http-exception";
import type { ServerRepositories } from "../database/repositories.js";
import type { WorkspaceRecord } from "../database/types.js";
import { RouteError } from "../http.js";
import type {
  SessionMessageRecord,
  SessionRecord,
  SessionSnapshotRecord,
  SessionStatusRecord,
  SessionTodoRecord,
  WorkspaceEventRecord,
} from "../schemas/sessions.js";
import type { RuntimeService } from "./runtime-service.js";
import { createLocalOpencodeSessionAdapter } from "../adapters/sessions/local-opencode.js";
import { OpenCodeBackendError } from "../adapters/sessions/opencode-backend.js";
import { createRemoteOpenworkSessionAdapter } from "../adapters/sessions/remote-openwork.js";

type SessionBackend = ReturnType<typeof createLocalOpencodeSessionAdapter>;

function toBackendKind(workspace: WorkspaceRecord) {
  return workspace.kind === "remote" ? "remote_openwork" : "local_opencode";
}

function readRuntimeState(repositories: ServerRepositories, workspace: WorkspaceRecord) {
  return repositories.workspaceRuntimeState.getByWorkspaceId(workspace.id);
}

function recordSuccess(repositories: ServerRepositories, workspace: WorkspaceRecord, input: { refresh?: boolean; sync?: boolean }) {
  const current = readRuntimeState(repositories, workspace);
  const now = new Date().toISOString();
  repositories.workspaceRuntimeState.upsert({
    backendKind: current?.backendKind ?? toBackendKind(workspace),
    health: current?.health ?? null,
    lastError: null,
    lastSessionRefreshAt: input.refresh ? now : current?.lastSessionRefreshAt ?? null,
    lastSyncAt: input.sync ? now : current?.lastSyncAt ?? null,
    workspaceId: workspace.id,
  });
}

function recordError(repositories: ServerRepositories, workspace: WorkspaceRecord, error: RouteError | Error) {
  const current = readRuntimeState(repositories, workspace);
  repositories.workspaceRuntimeState.upsert({
    backendKind: current?.backendKind ?? toBackendKind(workspace),
    health: current?.health ?? null,
    lastError: {
      code: error instanceof RouteError ? error.code : "internal_error",
      message: error.message,
      recordedAt: new Date().toISOString(),
    },
    lastSessionRefreshAt: current?.lastSessionRefreshAt ?? null,
    lastSyncAt: current?.lastSyncAt ?? null,
    workspaceId: workspace.id,
  });
}

function remapBackendError(error: unknown) {
  if (error instanceof RouteError) {
    throw error;
  }

  if (error instanceof OpenCodeBackendError) {
    if (error.status === 400) {
      throw new RouteError(400, "invalid_request", "Upstream session backend rejected the request.");
    }
    if (error.status === 404) {
      throw new HTTPException(404, { message: "Requested session resource was not found." });
    }
    if (error.status === 501) {
      throw new RouteError(501, "not_implemented", error.message || "Session operation is not supported by the resolved backend.");
    }
    throw new RouteError(502, "bad_gateway", error.message || "Resolved session backend request failed.");
  }

  if (error instanceof HTTPException) {
    throw error;
  }

  throw new RouteError(500, "internal_error", error instanceof Error ? error.message : "Unexpected session service failure.");
}

export type WorkspaceSessionService = ReturnType<typeof createWorkspaceSessionService>;

export function createWorkspaceSessionService(input: {
  repositories: ServerRepositories;
  runtime: RuntimeService;
}) {
  function getWorkspaceOrThrow(workspaceId: string) {
    const workspace = input.repositories.workspaces.getById(workspaceId);
    if (!workspace) {
      throw new HTTPException(404, { message: `Workspace not found: ${workspaceId}` });
    }
    return workspace;
  }

  function resolveBackend(workspace: WorkspaceRecord): SessionBackend {
    if (workspace.kind === "remote") {
      const server = input.repositories.servers.getById(workspace.serverId);
      if (!server) {
        throw new RouteError(502, "bad_gateway", `Workspace ${workspace.id} points at missing server ${workspace.serverId}.`);
      }
      return createRemoteOpenworkSessionAdapter({ server, workspace });
    }

    return createLocalOpencodeSessionAdapter({ runtime: input.runtime, workspace });
  }

  async function runRead<T>(workspaceId: string, operation: (backend: SessionBackend) => Promise<T>) {
    const workspace = getWorkspaceOrThrow(workspaceId);
    try {
      const result = await operation(resolveBackend(workspace));
      recordSuccess(input.repositories, workspace, { refresh: true });
      return result;
    } catch (error) {
      const remapped = (() => {
        try {
          remapBackendError(error);
        } catch (next) {
          return next;
        }
        return error;
      })();
      recordError(input.repositories, workspace, remapped as Error);
      throw remapped;
    }
  }

  async function runMutation<T>(workspaceId: string, operation: (backend: SessionBackend) => Promise<T>) {
    const workspace = getWorkspaceOrThrow(workspaceId);
    try {
      const result = await operation(resolveBackend(workspace));
      recordSuccess(input.repositories, workspace, { refresh: true, sync: true });
      return result;
    } catch (error) {
      const remapped = (() => {
        try {
          remapBackendError(error);
        } catch (next) {
          return next;
        }
        return error;
      })();
      recordError(input.repositories, workspace, remapped as Error);
      throw remapped;
    }
  }

  return {
    abortSession(workspaceId: string, sessionId: string) {
      return runMutation(workspaceId, (backend) => backend.abortSession(sessionId));
    },

    command(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.command(sessionId, body));
    },

    createSession(workspaceId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.createSession(body));
    },

    deleteMessage(workspaceId: string, sessionId: string, messageId: string) {
      return runMutation(workspaceId, (backend) => backend.deleteMessage(sessionId, messageId));
    },

    deleteMessagePart(workspaceId: string, sessionId: string, messageId: string, partId: string) {
      return runMutation(workspaceId, (backend) => backend.deleteMessagePart(sessionId, messageId, partId));
    },

    deleteSession(workspaceId: string, sessionId: string) {
      return runMutation(workspaceId, (backend) => backend.deleteSession(sessionId));
    },

    forkSession(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.forkSession(sessionId, body));
    },

    getMessage(workspaceId: string, sessionId: string, messageId: string): Promise<SessionMessageRecord> {
      return runRead(workspaceId, (backend) => backend.getMessage(sessionId, messageId));
    },

    getSession(workspaceId: string, sessionId: string): Promise<SessionRecord> {
      return runRead(workspaceId, (backend) => backend.getSession(sessionId));
    },

    getSessionSnapshot(workspaceId: string, sessionId: string, input?: { limit?: number }): Promise<SessionSnapshotRecord> {
      return runRead(workspaceId, (backend) => backend.getSessionSnapshot(sessionId, input));
    },

    async getSessionStatus(workspaceId: string, sessionId: string): Promise<SessionStatusRecord> {
      const statuses = await runRead(workspaceId, (backend) => backend.listStatuses());
      return statuses[sessionId] ?? { type: "idle" };
    },

    initSession(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.initSession(sessionId, body));
    },

    listMessages(workspaceId: string, sessionId: string, input?: { limit?: number }): Promise<SessionMessageRecord[]> {
      return runRead(workspaceId, (backend) => backend.listMessages(sessionId, input));
    },

    listSessions(workspaceId: string, input?: { limit?: number; roots?: boolean; search?: string; start?: number }): Promise<SessionRecord[]> {
      return runRead(workspaceId, (backend) => backend.listSessions(input));
    },

    listSessionStatuses(workspaceId: string): Promise<Record<string, SessionStatusRecord>> {
      return runRead(workspaceId, (backend) => backend.listStatuses());
    },

    listTodos(workspaceId: string, sessionId: string): Promise<SessionTodoRecord[]> {
      return runRead(workspaceId, (backend) => backend.listTodos(sessionId));
    },

    promptAsync(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.promptAsync(sessionId, body));
    },

    revert(workspaceId: string, sessionId: string, body: { messageID: string }) {
      return runMutation(workspaceId, (backend) => backend.revert(sessionId, body));
    },

    sendMessage(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.sendMessage(sessionId, body));
    },

    shareSession(workspaceId: string, sessionId: string) {
      return runMutation(workspaceId, (backend) => backend.shareSession(sessionId));
    },

    shell(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.shell(sessionId, body));
    },

    async streamWorkspaceEvents(workspaceId: string, signal?: AbortSignal): Promise<AsyncIterable<WorkspaceEventRecord>> {
      const workspace = getWorkspaceOrThrow(workspaceId);
      try {
        return await resolveBackend(workspace).streamEvents(signal);
      } catch (error) {
        const remapped = (() => {
          try {
            remapBackendError(error);
          } catch (next) {
            return next;
          }
          return error;
        })();
        recordError(input.repositories, workspace, remapped as Error);
        throw remapped;
      }
    },

    summarizeSession(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.summarizeSession(sessionId, body));
    },

    unshareSession(workspaceId: string, sessionId: string) {
      return runMutation(workspaceId, (backend) => backend.unshareSession(sessionId));
    },

    unrevert(workspaceId: string, sessionId: string) {
      return runMutation(workspaceId, (backend) => backend.unrevert(sessionId));
    },

    updateMessagePart(workspaceId: string, sessionId: string, messageId: string, partId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.updateMessagePart(sessionId, messageId, partId, body));
    },

    updateSession(workspaceId: string, sessionId: string, body: Record<string, unknown>) {
      return runMutation(workspaceId, (backend) => backend.updateSession(sessionId, body));
    },
  };
}
