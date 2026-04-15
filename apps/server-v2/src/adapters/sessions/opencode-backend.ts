import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import type {
  SessionMessageRecord,
  SessionRecord,
  SessionSnapshotRecord,
  SessionStatusRecord,
  SessionTodoRecord,
  WorkspaceEventRecord,
} from "../../schemas/sessions.js";
import {
  parseSessionData,
  parseSessionListData,
  parseSessionMessageData,
  parseSessionMessagesData,
  parseSessionStatusesData,
  parseSessionTodosData,
  parseWorkspaceEventData,
} from "../../schemas/sessions.js";

export class OpenCodeBackendError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OpenCodeBackendError";
  }
}

type OpenCodeBackendOptions = {
  baseUrl: string;
  directory?: string | null;
  headers?: Record<string, string>;
};

type RequestOptions = {
  body?: unknown;
  method?: string;
  query?: Record<string, string | number | boolean | undefined>;
  signal?: AbortSignal;
};

function buildDirectoryHeader(directory?: string | null) {
  const trimmed = directory?.trim() ?? "";
  if (!trimmed) {
    return null;
  }
  return /[^\x00-\x7F]/.test(trimmed) ? encodeURIComponent(trimmed) : trimmed;
}

function buildUrl(baseUrl: string, path: string, query?: RequestOptions["query"]) {
  const url = new URL(path, `${baseUrl.replace(/\/+$/, "")}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function parseJsonResponse(response: Response) {
  const text = await response.text();
  if (!text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toBackendError(response: Response, payload: unknown) {
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : null;
  const code = typeof record?.code === "string" ? record.code : "opencode_request_failed";
  const message = typeof record?.message === "string" ? record.message : response.statusText || "OpenCode request failed.";
  const details = record?.details;
  return new OpenCodeBackendError(response.status, code, message, details);
}

export type OpenCodeSessionBackend = ReturnType<typeof createOpenCodeSessionBackend>;

export function createOpenCodeSessionBackend(options: OpenCodeBackendOptions) {
  const normalizedBaseUrl = options.baseUrl.replace(/\/+$/, "");
  const baseHeaders = { ...(options.headers ?? {}) };
  const directoryHeader = buildDirectoryHeader(options.directory);
  if (directoryHeader) {
    baseHeaders["x-opencode-directory"] = directoryHeader;
  }

  const eventClient = createOpencodeClient({
    baseUrl: normalizedBaseUrl,
    directory: options.directory ?? undefined,
    headers: Object.keys(baseHeaders).length ? baseHeaders : undefined,
    responseStyle: "data",
    throwOnError: true,
  });

  async function requestJson(path: string, request: RequestOptions = {}) {
    const url = buildUrl(normalizedBaseUrl, path, request.query);
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers: {
        ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...baseHeaders,
      },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: request.signal,
    });

    const payload = await parseJsonResponse(response);
    if (!response.ok) {
      throw toBackendError(response, payload);
    }
    return payload;
  }

  async function requestVoid(path: string, request: RequestOptions = {}) {
    const url = buildUrl(normalizedBaseUrl, path, request.query);
    const response = await fetch(url, {
      method: request.method ?? "POST",
      headers: {
        ...(request.body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...baseHeaders,
      },
      body: request.body !== undefined ? JSON.stringify(request.body) : undefined,
      signal: request.signal,
    });

    if (!response.ok) {
      throw toBackendError(response, await parseJsonResponse(response));
    }
  }

  return {
    async abortSession(sessionId: string) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" });
    },

    async command(sessionId: string, body: Record<string, unknown>) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/command`, { body, method: "POST" });
    },

    async createSession(body: Record<string, unknown>) {
      return parseSessionData(await requestJson("/session", { body, method: "POST" }));
    },

    async deleteMessage(sessionId: string, messageId: string) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      });
    },

    async deleteMessagePart(sessionId: string, messageId: string, partId: string) {
      await requestVoid(
        `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}/part/${encodeURIComponent(partId)}`,
        { method: "DELETE" },
      );
    },

    async deleteSession(sessionId: string) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    },

    async forkSession(sessionId: string, body: Record<string, unknown>) {
      return parseSessionData(await requestJson(`/session/${encodeURIComponent(sessionId)}/fork`, { body, method: "POST" }));
    },

    async getMessage(sessionId: string, messageId: string) {
      return parseSessionMessageData(
        await requestJson(`/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}`),
      );
    },

    async getSession(sessionId: string) {
      return parseSessionData(await requestJson(`/session/${encodeURIComponent(sessionId)}`));
    },

    async getSessionSnapshot(sessionId: string, input?: { limit?: number }) {
      const [session, messages, todos, statuses] = await Promise.all([
        this.getSession(sessionId),
        this.listMessages(sessionId, input),
        this.listTodos(sessionId),
        this.listStatuses(),
      ]);

      return {
        messages,
        session,
        status: statuses[sessionId] ?? { type: "idle" },
        todos,
      } satisfies SessionSnapshotRecord;
    },

    async initSession(sessionId: string, body: Record<string, unknown>) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/init`, { body, method: "POST" });
    },

    async listMessages(sessionId: string, input?: { limit?: number }) {
      return parseSessionMessagesData(
        await requestJson(`/session/${encodeURIComponent(sessionId)}/message`, {
          query: { limit: input?.limit },
        }),
      );
    },

    async listSessions(input?: { limit?: number; roots?: boolean; search?: string; start?: number }) {
      return parseSessionListData(await requestJson("/session", { query: input }));
    },

    async listStatuses() {
      return parseSessionStatusesData(await requestJson("/session/status"));
    },

    async listTodos(sessionId: string) {
      return parseSessionTodosData(await requestJson(`/session/${encodeURIComponent(sessionId)}/todo`));
    },

    async promptAsync(sessionId: string, body: Record<string, unknown>) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/prompt_async`, { body, method: "POST" });
    },

    async revert(sessionId: string, body: { messageID: string }) {
      return parseSessionData(await requestJson(`/session/${encodeURIComponent(sessionId)}/revert`, { body, method: "POST" }));
    },

    async sendMessage(sessionId: string, body: Record<string, unknown>) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/message`, { body, method: "POST" });
    },

    async shareSession(sessionId: string) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/share`, { method: "POST" });
    },

    async shell(sessionId: string, body: Record<string, unknown>) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/shell`, { body, method: "POST" });
    },

    async streamEvents(signal?: AbortSignal): Promise<AsyncIterable<WorkspaceEventRecord>> {
      const subscription = await eventClient.event.subscribe(undefined, { signal });
      const source = subscription.stream as AsyncIterable<unknown>;
      const iterator = async function* () {
        for await (const event of source) {
          if (!event || typeof event !== "object") {
            continue;
          }

          const record = event as Record<string, unknown>;
          if (typeof record.type === "string") {
            yield parseWorkspaceEventData({
              properties: record.properties,
              type: record.type,
            });
            continue;
          }

          const payload = record.payload;
          if (payload && typeof payload === "object" && typeof (payload as Record<string, unknown>).type === "string") {
            yield parseWorkspaceEventData(payload);
          }
        }
      };

      return iterator();
    },

    async summarizeSession(sessionId: string, body: Record<string, unknown>) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/summarize`, { body, method: "POST" });
    },

    async unshareSession(sessionId: string) {
      await requestVoid(`/session/${encodeURIComponent(sessionId)}/share`, { method: "DELETE" });
    },

    async unrevert(sessionId: string) {
      return parseSessionData(await requestJson(`/session/${encodeURIComponent(sessionId)}/unrevert`, { method: "POST" }));
    },

    async updateMessagePart(sessionId: string, messageId: string, partId: string, body: Record<string, unknown>) {
      await requestVoid(
        `/session/${encodeURIComponent(sessionId)}/message/${encodeURIComponent(messageId)}/part/${encodeURIComponent(partId)}`,
        { body, method: "PATCH" },
      );
    },

    async updateSession(sessionId: string, body: Record<string, unknown>) {
      return parseSessionData(await requestJson(`/session/${encodeURIComponent(sessionId)}`, { body, method: "PATCH" }));
    },
  };
}
