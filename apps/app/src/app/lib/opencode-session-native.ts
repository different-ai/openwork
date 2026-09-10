import type { Message, Part, Session, SessionStatus, Todo } from "@opencode-ai/sdk/v2/client";

import { closeSessionBrowserTabs } from "./desktop";
import { createClient, unwrap, type FieldsResult } from "./opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "./opencode-v2-adapter";
import type { OpenworkSessionSnapshot } from "./openwork-server";
import type { ResolvedWorkspaceEndpoint } from "./workspace-endpoint";

type NativeSessionEndpoint = Pick<ResolvedWorkspaceEndpoint, "opencodeBaseUrl" | "token">;
type RequestOptions = { signal?: AbortSignal };

export type NativeSessionSnapshotTarget = {
  owner: string;
  endpoint: NativeSessionEndpoint;
  sessionId: string;
};

export type NativeSessionOperations = {
  get: (sessionId: string, options?: RequestOptions) => Promise<FieldsResult<Session>>;
  messages: (sessionId: string, limit: number | undefined, options?: RequestOptions) => Promise<FieldsResult<Array<{ info: Message; parts: Part[] }>>>;
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
  const client = isOpencodeV2BaseUrl(endpoint.opencodeBaseUrl)
    ? createClientV2(endpoint.opencodeBaseUrl, undefined, { token: endpoint.token })
    : createClient(endpoint.opencodeBaseUrl, undefined, { mode: "openwork", token: endpoint.token });
  return {
    get: (sessionId, options) => client.session.get({ sessionID: sessionId }, options),
    messages: (sessionId, limit, options) => client.session.messages({ sessionID: sessionId, limit }, options),
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
      Object.assign(error, { status: result.response.status });
      const code = result.error && typeof result.error === "object" && "code" in result.error && typeof result.error.code === "string"
        ? result.error.code
        : result.response.status === 404
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

export async function getNativeSessionMessages(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: RequestOptions & { limit?: number },
  dependencies?: NativeSessionDependencies,
) {
  const result = await sessionOperations(endpoint, dependencies).messages(sessionId, options?.limit, options);
  return unwrapSessionResult(result, "session_not_found");
}

export async function composeNativeSessionSnapshot(
  endpoint: NativeSessionEndpoint,
  sessionId: string,
  options?: RequestOptions & { limit?: number },
  dependencies?: NativeSessionDependencies,
): Promise<OpenworkSessionSnapshot> {
  const operations = sessionOperations(endpoint, dependencies);
  const [sessionResult, messagesResult, todoResult, statusResult] = await Promise.all([
    operations.get(sessionId, options),
    operations.messages(sessionId, options?.limit, options),
    operations.todo(sessionId, options),
    operations.status(options),
  ]);
  const session = unwrapSessionResult(sessionResult, "session_not_found");
  const messages = unwrapSessionResult(messagesResult, "session_not_found");
  const todos = unwrapSessionResult(todoResult, "session_not_found");
  const statuses = unwrapSessionResult(statusResult);
  return { session, messages, todos, status: statuses[sessionId] ?? { type: "idle" } };
}

export async function composeNativeSessionSnapshotWithRetry(
  expectedOwner: string,
  readCurrentTarget: () => NativeSessionSnapshotTarget,
  options: RequestOptions & { limit?: number },
  dependencies?: NativeSessionDependencies,
): Promise<OpenworkSessionSnapshot> {
  const signal = options.signal ?? new AbortController().signal;
  const waitForRetry = dependencies?.waitForSnapshotRetry ?? waitForSnapshotRetry;
  let attempt = 0;
  while (true) {
    signal.throwIfAborted();
    const target = readOwnedSnapshotTarget(expectedOwner, readCurrentTarget);
    try {
      const snapshot = await composeNativeSessionSnapshot(
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
      if (delayMs === undefined) throw error;
      attempt += 1;
      await waitForRetry(delayMs, signal);
    }
  }
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
