import type { Message, Part, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { closeSessionBrowserTabs } from "./desktop";
import { createClient, unwrap, type FieldsResult } from "./opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "./opencode-v2-adapter";
import type { OpenworkSessionHistory, OpenworkSessionSnapshot } from "./openwork-server";
import type { ResolvedWorkspaceEndpoint } from "./workspace-endpoint";

type NativeSessionEndpoint = Pick<ResolvedWorkspaceEndpoint, "opencodeBaseUrl" | "token"> & { desktopTransport?: "main" };
type RequestOptions = { signal?: AbortSignal };
type MessageReadOptions = RequestOptions & { limit?: number; before?: string };
type HistoryReadOptions = MessageReadOptions & { messageIds?: readonly string[] };
type MessageReadResult = FieldsResult<Array<{ info: Message; parts: Part[] }>> & Pick<OpenworkSessionHistory, "pagination">;

export type NativeSessionSnapshotTarget = {
  owner: string;
  endpoint: NativeSessionEndpoint;
  sessionId: string;
};

export type NativeSessionOperations = {
  get: (sessionId: string, options?: RequestOptions) => Promise<FieldsResult<Session>>;
  messages: (sessionId: string, limit: number | undefined, options?: RequestOptions & { before?: string }) => Promise<MessageReadResult>;
  message?: (sessionId: string, messageId: string, options?: RequestOptions) => Promise<FieldsResult<{ info: Message; parts: Part[] }>>;
  todo: (sessionId: string, options?: RequestOptions) => Promise<FieldsResult<Todo[]>>;
  status: (options?: RequestOptions) => Promise<FieldsResult<Record<string, SessionStatus>>>;
  delete: (sessionId: string, options?: RequestOptions) => Promise<FieldsResult<boolean>>;
};

export type NativeSessionDependencies = {
  createOperations?: (endpoint: NativeSessionEndpoint) => NativeSessionOperations;
  waitForSnapshotRetry?: (delayMs: number, signal: AbortSignal) => Promise<void>;
};

const SNAPSHOT_RETRY_DELAYS_MS = [100, 250, 500];

function waitForSnapshotRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readOwnedSnapshotTarget(
  expectedOwner: string,
  readCurrentTarget: () => NativeSessionSnapshotTarget,
) {
  const target = readCurrentTarget();
  if (target.owner !== expectedOwner) {
    throw new Error("Session snapshot owner changed before the local read completed.");
  }
  return target;
}

function createNativeOperations(endpoint: NativeSessionEndpoint): NativeSessionOperations {
  const v2 = isOpencodeV2BaseUrl(endpoint.opencodeBaseUrl)
    ? createClientV2(endpoint.opencodeBaseUrl, undefined, { token: endpoint.token })
    : undefined;
  const client = v2 ?? createClient(endpoint.opencodeBaseUrl, undefined, { mode: "openwork", token: endpoint.token },
    endpoint.desktopTransport ? { desktopTransport: endpoint.desktopTransport } : undefined);
  return {
    get: (sessionId, options) => client.session.get({ sessionID: sessionId }, options),
    messages: async (sessionId, limit, options) => {
      const parameters = { sessionID: sessionId, limit, before: options?.before };
      const result = await client.session.messages(parameters, options);
      if (result.data === undefined || limit === undefined || !Number.isInteger(limit) || limit <= 0) return result;
      if (v2) {
        const pagination = "pagination" in result ? result.pagination : undefined;
        if (pagination === undefined) return result;
        if (!pagination || typeof pagination !== "object"
          || !("limit" in pagination) || typeof pagination.limit !== "number"
          || !("nextCursor" in pagination) || (pagination.nextCursor !== null && typeof pagination.nextCursor !== "string")) {
          throw new Error("Invalid session history pagination metadata.");
        }
        return { ...result, pagination: { before: options?.before, nextCursor: pagination.nextCursor, limit: pagination.limit } };
      }
      const nextCursor = result.response.headers.get("X-Next-Cursor");
      if (nextCursor !== null && nextCursor === options?.before) {
        throw new Error("Session history pagination cursor did not advance.");
      }
      return { ...result, pagination: { before: options?.before, nextCursor, limit } };
    },
    message: (sessionId, messageId, options) => client.session.message({ sessionID: sessionId, messageID: messageId }, options),
    todo: (sessionId, options) => client.session.todo({ sessionID: sessionId }, options),
    status: (options) => client.session.status(undefined, options),
    delete: (sessionId, options) => client.session.delete({ sessionID: sessionId }, options),
  };
}

function sessionOperations(endpoint: NativeSessionEndpoint, dependencies?: NativeSessionDependencies) {
  return (dependencies?.createOperations ?? createNativeOperations)(endpoint);
}

function unwrapSessionResult<T>(result: FieldsResult<T>, notFoundCode?: string): NonNullable<T> {
  try {
    return unwrap(result);
  } catch (error) {
    if (error instanceof Error) {
      // A transport failure (timeout, refused connection) settles without a
      // response; keep its own message rather than replacing it with a TypeError.
      const status = result.response?.status;
      if (status !== undefined) Object.assign(error, { status });
      const code = result.error && typeof result.error === "object" && "code" in result.error && typeof result.error.code === "string"
        ? result.error.code
        : status === 404
          ? notFoundCode
          : undefined;
      if (code) Object.assign(error, { code });
    }
    throw error;
  }
}

export async function getNativeSession(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: RequestOptions,
  dependencies?: NativeSessionDependencies,
) {
  const result = await sessionOperations(endpoint, dependencies).get(sessionId, options);
  return unwrapSessionResult(result, "session_not_found");
}

function validateMessageRead(options?: MessageReadOptions) {
  options?.signal?.throwIfAborted();
  if (options?.before !== undefined && (options.limit === undefined || !Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error("A session history cursor requires a positive integer limit.");
  }
}

export async function getNativeSessionMessages(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: MessageReadOptions,
  dependencies?: NativeSessionDependencies,
) {
  validateMessageRead(options);
  const result = await sessionOperations(endpoint, dependencies).messages(sessionId, options?.limit, options);
  options?.signal?.throwIfAborted();
  return unwrapSessionResult(result, "session_not_found");
}

async function readNativeSessionHistory(
  operations: NativeSessionOperations,
  sessionId: string,
  options?: HistoryReadOptions,
): Promise<OpenworkSessionHistory> {
  options?.signal?.throwIfAborted();
  if (options?.messageIds === undefined) validateMessageRead(options);
  const controller = new AbortController();
  const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const readOptions = { ...options, signal };
  let pagination: OpenworkSessionHistory["pagination"];
  const readSession = async () => {
    const result = await operations.get(sessionId, readOptions);
    signal.throwIfAborted();
    const session = unwrapSessionResult(result, "session_not_found");
    if (session.id !== sessionId) throw new Error("Could not verify the session history owner.");
    return session;
  };
  const readMessages = async () => {
    if (options?.messageIds === undefined) {
      const result = await operations.messages(sessionId, options?.limit, readOptions);
      signal.throwIfAborted();
      const messages = unwrapSessionResult(result, "session_not_found");
      if (messages.some((record) => record.info.sessionID !== sessionId
        || record.parts.some((part) => part.sessionID !== sessionId || part.messageID !== record.info.id))) {
        throw new Error("Could not verify the session history owner.");
      }
      if (options?.limit !== undefined && Number.isInteger(options.limit) && options.limit > 0) pagination = result.pagination;
      return messages;
    }
    const ids = [...new Set(options.messageIds)].slice(0, 24);
    const records = await Promise.all(ids.map(async (messageId) => {
      signal.throwIfAborted();
      if (!messageId.trim() || messageId === "." || messageId === "..") {
        throw new Error("Invalid saved session message ID.");
      }
      if (!operations.message) throw new Error("Native single-message reads are unavailable.");
      const result = await operations.message(sessionId, messageId, readOptions);
      signal.throwIfAborted();
      if (result.response?.status === 404) return [];
      const record = unwrapSessionResult(result, "message_not_found");
      if (record.info.id !== messageId || record.info.sessionID !== sessionId
        || record.parts.some((part) => part.messageID !== messageId || part.sessionID !== sessionId)) {
        throw new Error("Could not verify the saved session message owner.");
      }
      return [record];
    }));
    return records.flat();
  };
  try {
    const [session, messages] = await Promise.all([readSession(), readMessages()]);
    signal.throwIfAborted();
    return { session, messages, ...(pagination ? { pagination } : {}) };
  } finally {
    controller.abort();
  }
}

export async function composeNativeSessionHistory(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: HistoryReadOptions,
  dependencies?: NativeSessionDependencies,
): Promise<OpenworkSessionHistory> {
  return readNativeSessionHistory(sessionOperations(endpoint, dependencies), sessionId, options);
}

export async function composeNativeSessionSnapshot(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: HistoryReadOptions,
  dependencies?: NativeSessionDependencies,
): Promise<OpenworkSessionSnapshot> {
  const operations = sessionOperations(endpoint, dependencies);
  const [history, todoResult, statusResult] = await Promise.all([
    readNativeSessionHistory(operations, sessionId, options),
    operations.todo(sessionId, options),
    operations.status(options),
  ]);
  const todos = unwrapSessionResult(todoResult, "session_not_found");
  const statuses = unwrapSessionResult(statusResult);
  return { ...history, todos, status: statuses[sessionId] ?? { type: "idle" } };
}

function isRetryableNativeSessionError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = "status" in error && typeof error.status === "number" ? error.status : undefined;
  if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return false;
  const name = "name" in error && typeof error.name === "string" ? error.name : "";
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  const detail = `${name} ${code} ${message}`;
  if (name === "AbortError" || name === "SyntaxError" || name === "RangeError"
    || /invalid|malformed|pagination|positive integer limit|verify.*owner|owner changed|too[ _-]large|size.*exceed|exceed.*(?:size|limit)|single-message reads are unavailable/i.test(detail)) return false;
  if (status !== undefined) return status === 408 || status === 429 || (status >= 500 && status < 600);
  return /fetch failed|failed to fetch|load failed|network|connection|ECONN|ENET|EHOST|EAI_AGAIN|ETIMEDOUT|timed? ?out|unavailable|reloading/i.test(detail);
}

async function readOwnedNativeSessionWithRetry<T>(
  expectedOwner: string,
  readCurrentTarget: () => NativeSessionSnapshotTarget,
  options: HistoryReadOptions,
  dependencies: NativeSessionDependencies | undefined,
  read: (endpoint: NativeSessionEndpoint, sessionId: string, readOptions: HistoryReadOptions, dependencies?: NativeSessionDependencies) => Promise<T>,
): Promise<T> {
  const signal = options.signal ?? new AbortController().signal;
  const waitForRetry = dependencies?.waitForSnapshotRetry ?? waitForSnapshotRetry;
  let attempt = 0;
  while (true) {
    signal.throwIfAborted();
    const target = readOwnedSnapshotTarget(expectedOwner, readCurrentTarget);
    try {
      const snapshot = await read(
        target.endpoint,
        target.sessionId,
        options,
        dependencies,
      );
      signal.throwIfAborted();
      readOwnedSnapshotTarget(expectedOwner, readCurrentTarget);
      return snapshot;
    } catch (error) {
      signal.throwIfAborted();
      readOwnedSnapshotTarget(expectedOwner, readCurrentTarget);
      const delayMs = SNAPSHOT_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRetryableNativeSessionError(error)) throw error;
      attempt += 1;
      await waitForRetry(delayMs, signal);
    }
  }
}

export function composeNativeSessionHistoryWithRetry(
  expectedOwner: string,
  readCurrentTarget: () => NativeSessionSnapshotTarget,
  options: HistoryReadOptions,
  dependencies?: NativeSessionDependencies,
) {
  return readOwnedNativeSessionWithRetry(expectedOwner, readCurrentTarget, options, dependencies, composeNativeSessionHistory);
}

export function composeNativeSessionSnapshotWithRetry(
  expectedOwner: string,
  readCurrentTarget: () => NativeSessionSnapshotTarget,
  options: HistoryReadOptions,
  dependencies?: NativeSessionDependencies,
) {
  return readOwnedNativeSessionWithRetry(expectedOwner, readCurrentTarget, options, dependencies, composeNativeSessionSnapshot);
}

export async function deleteNativeSession(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: RequestOptions,
  dependencies?: NativeSessionDependencies,
) {
  const result = await sessionOperations(endpoint, dependencies).delete(sessionId, options);
  const deleted = unwrapSessionResult(result, "session_not_found");
  if (deleted) void closeSessionBrowserTabs(sessionId);
  return deleted;
}
