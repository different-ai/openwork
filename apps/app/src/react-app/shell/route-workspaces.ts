// Shared pure helpers for the workspace-scoped routes (session-route,
// settings-route). These were duplicated in both route files and had drifted:
// settings-route was missing the remote-workspace clobber fix in
// mergeRouteWorkspaces and used older session-status logic. One copy now.

import type { Session } from "@opencode-ai/sdk/v2/client";

import { createClient, unwrap } from "@/app/lib/opencode";
import { createClientV2, isOpencodeV2BaseUrl } from "@/app/lib/opencode-v2-adapter";
import { deleteNativeSession } from "@/app/lib/opencode-session-native";
import { OpenworkServerError, type OpenworkWorkspaceInfo } from "@/app/lib/openwork-server";
import type { ResolvedWorkspaceEndpoint } from "@/app/lib/workspace-endpoint";
import type { WorkspaceInfo } from "@/app/lib/desktop-types";
import type { WorkspaceSessionGroup } from "@/app/types";
import {
  normalizeDirectoryPath,
  normalizeSessionStatus,
  safeStringify,
} from "@/app/utils";
import { t } from "@/i18n";

export type RouteWorkspace = OpenworkWorkspaceInfo & {
  displayNameResolved: string;
};

/**
 * Sessions as the routes handle them: native SDK sessions, optionally enriched with run-status
 * fields that the sidebar probes defensively via getSessionStatus.
 */
export type RouteSession = Session & {
  status?: unknown;
  state?: unknown;
  runStatus?: unknown;
  slug?: string | null;
};

type RouteSessionListResult =
  | { data: RouteSession[]; error?: undefined; request: Request; response: Response }
  | { data?: undefined; error: unknown; request: Request; response: Response };
export type RouteSessionListTransport = (input: {
  endpoint: ResolvedWorkspaceEndpoint;
  limit: number;
}) => Promise<RouteSessionListResult>;

const nativeRouteSessionList: RouteSessionListTransport = async ({ endpoint, limit }) => {
  const client = createClient(endpoint.opencodeBaseUrl, undefined, {
    mode: "openwork",
    token: endpoint.token,
  });
  return client.session.list({ limit });
};

export const v2RouteSessionList: RouteSessionListTransport = async ({ endpoint, limit }) =>
  createClientV2(`${endpoint.mountedBaseUrl}/opencode2`, undefined, {
    token: endpoint.token,
  }).session.list({ limit });

/** Resolve the owning server's engine even when this workspace isn't selected. */
async function routeSessionEndpoint(endpoint: ResolvedWorkspaceEndpoint): Promise<ResolvedWorkspaceEndpoint> {
  const status = await endpoint.client.getEngineV2PreviewStatus().catch((error: unknown) => {
    // Servers predating the preview endpoint still use v1.
    if (error instanceof OpenworkServerError && error.status === 404) return null;
    throw error;
  });
  return status?.enabled && status.chatRouting
    ? { ...endpoint, opencodeBaseUrl: `${endpoint.mountedBaseUrl}/opencode2` }
    : endpoint;
}

export async function createRouteSession(endpoint: ResolvedWorkspaceEndpoint, directory?: string): Promise<Session> {
  const native = await routeSessionEndpoint(endpoint);
  const client = isOpencodeV2BaseUrl(native.opencodeBaseUrl)
    ? createClientV2(native.opencodeBaseUrl, directory, { token: native.token })
    : createClient(native.opencodeBaseUrl, directory, { token: native.token, mode: "openwork" });
  return unwrap(await client.session.create({ directory }));
}

export async function deleteRouteSession(endpoint: ResolvedWorkspaceEndpoint, sessionId: string): Promise<boolean> {
  return deleteNativeSession(await routeSessionEndpoint(endpoint), sessionId);
}

export async function listRouteSessions(
  endpoint: ResolvedWorkspaceEndpoint,
  transport: RouteSessionListTransport = nativeRouteSessionList,
): Promise<RouteSession[]> {
  const result = await transport({ endpoint, limit: 200 });
  try {
    return unwrap(result);
  } catch (error) {
    if (error instanceof Error) {
      Object.assign(error, { status: result.response.status });
      if (result.error && typeof result.error === "object" && "code" in result.error && typeof result.error.code === "string") {
        Object.assign(error, { code: result.error.code });
      }
    }
    throw error;
  }
}

export function mapDesktopWorkspace(workspace: WorkspaceInfo): RouteWorkspace {
  return {
    ...workspace,
    displayNameResolved:
      workspace.displayName?.trim() ||
      workspace.name?.trim() ||
      workspace.path?.trim() ||
      t("session.workspace_fallback"),
  };
}

export function workspaceLabel(workspace: OpenworkWorkspaceInfo) {
  return (
    workspace.displayName?.trim() ||
    workspace.openworkWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.path?.trim() ||
    t("session.workspace_fallback")
  );
}

export function workspaceExportFilename(workspace: OpenworkWorkspaceInfo) {
  const slug = workspaceLabel(workspace).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${slug || "workspace"}-openwork-export.json`;
}

export function downloadWorkspaceJson(filename: string, payload: unknown) {
  if (typeof document === "undefined") return;
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function folderNameFromPath(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "workspace";
}

export function isTransientStartupError(message: string | null | undefined) {
  const value = (message ?? "").toLowerCase();
  return (
    value.includes("timed out") ||
    value.includes("failed to fetch") ||
    value.includes("connection") ||
    value.includes("not ready")
  );
}

export function describeRouteError(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  const serialized = safeStringify(error);
  return serialized && serialized !== "{}" ? serialized : t("app.unknown_error");
}

export function classifyRouteSessionReadError(error: unknown): "not-found" | "retryable" | "error" {
  const status = error instanceof Error && "status" in error && typeof error.status === "number"
    ? error.status
    : null;
  const code = error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  if (code === "session_not_found") return "not-found";
  if (
    code === "opencode_unconfigured" ||
    code === "opencode_engine_unreachable" ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    isTransientStartupError(describeRouteError(error))
  ) {
    return "retryable";
  }
  return "error";
}

/**
 * Engine calls can briefly fail while the desktop server is up but the
 * workspace engine is not answering: startup, a blue/green rollover, or an
 * overloaded event loop that misses the 10 s request timeout. Keep that gap
 * inside a bounded retry instead of a dead-end error. Terminal authorization
 * and workspace errors still fail immediately. `onRetry` fires before each
 * wait with the 1-based attempt that just failed.
 */
export async function withTransientEngineRetry<T>(input: {
  load: () => Promise<T>;
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
  onRetry?: (attempt: number, error: unknown) => void;
}): Promise<T> {
  const retryDelaysMs = input.retryDelaysMs ?? [];
  const wait = input.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await input.load();
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs === undefined || classifyRouteSessionReadError(error) !== "retryable") {
        throw error;
      }
      input.onRetry?.(attempt + 1, error);
      await wait(retryDelayMs);
    }
  }
}

export const readRouteSessionsWithRetry = withTransientEngineRetry;

/** Waits between task-creation attempts; each attempt itself may take the 10 s request timeout. */
export const TASK_CREATE_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000];

export type TaskCreateFailure = {
  kind: "not_responding" | "unavailable";
  title: string;
  description: string;
};

/**
 * A stalled engine (timeouts, connection blips, 5xx from the proxy) is a
 * different situation from a misconfigured or missing one: it usually comes
 * back on its own or after a reload, and the person should not have to reload
 * the whole app to find out.
 */
export function describeTaskCreateFailure(error: unknown, attempts: number): TaskCreateFailure {
  const message = describeRouteError(error);
  if (classifyRouteSessionReadError(error) === "retryable") {
    return {
      kind: "not_responding",
      title: t("session.engine_not_responding_title"),
      description: t("session.engine_not_responding_detail", { attempts: String(attempts) }),
    };
  }
  return { kind: "unavailable", title: t("session.engine_unavailable_title"), description: message };
}

export type TaskCreateRetryNotice = { title: string; description: string };

/** Retry countdown wording; engine internals stay behind developer mode. */
export function describeTaskCreateRetry(input: {
  developerMode: boolean;
  attempt: number;
  attempts: number;
}): TaskCreateRetryNotice {
  if (input.developerMode) {
    return {
      title: t("session.engine_catching_up_title"),
      description: t("session.engine_catching_up_detail", { attempt: input.attempt, total: input.attempts }),
    };
  }
  return {
    title: t("session.still_loading_title"),
    description: t("session.still_loading_detail"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOpenworkWorkspaceArray(value: unknown): value is OpenworkWorkspaceInfo[] {
  return Array.isArray(value);
}

function routeListActiveId(list: unknown) {
  if (!isRecord(list)) return null;
  return typeof list.activeId === "string" ? list.activeId.trim() || null : null;
}

export type RouteWorkspaceListState = {
  activeId: string | null;
  error: unknown | null;
  usable: boolean;
  workspaces: RouteWorkspace[];
};

export function resolveRouteWorkspaceListState(input: {
  list: unknown;
  desktopWorkspaces: RouteWorkspace[];
  previousWorkspaces: RouteWorkspace[];
  orderIds: string[];
}): RouteWorkspaceListState {
  const serverItems = isRecord(input.list) && isOpenworkWorkspaceArray(input.list.items) ? input.list.items : null;
  const workspaces = serverItems
    ? mergeRouteWorkspaces(serverItems, input.desktopWorkspaces)
    : input.previousWorkspaces.length > 0
      ? input.previousWorkspaces
      : input.desktopWorkspaces;

  return {
    activeId: routeListActiveId(input.list),
    error: null,
    usable: serverItems !== null,
    workspaces: orderRouteWorkspaces(workspaces, input.orderIds),
  };
}

export async function refreshRouteWorkspaceListState(input: {
  load: () => Promise<unknown>;
  desktopWorkspaces: RouteWorkspace[];
  previousWorkspaces: RouteWorkspace[];
  orderIds: string[];
  /** Optional startup backoff. Route callers opt in when their local server
   * can briefly accept connections before its workspace API is ready. */
  retryDelaysMs?: readonly number[];
  wait?: (delayMs: number) => Promise<void>;
}): Promise<RouteWorkspaceListState> {
  const retryDelaysMs = input.retryDelaysMs ?? [];
  const wait = input.wait ?? ((delayMs: number) => new Promise<void>((resolve) => {
    window.setTimeout(resolve, delayMs);
  }));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return resolveRouteWorkspaceListState({
        list: await input.load(),
        desktopWorkspaces: input.desktopWorkspaces,
        previousWorkspaces: input.previousWorkspaces,
        orderIds: input.orderIds,
      });
    } catch (error) {
      const retryDelayMs = retryDelaysMs[attempt];
      if (retryDelayMs !== undefined && isTransientStartupError(describeRouteError(error))) {
        await wait(retryDelayMs);
        continue;
      }
      const state = resolveRouteWorkspaceListState({
        list: null,
        desktopWorkspaces: input.desktopWorkspaces,
        previousWorkspaces: input.previousWorkspaces,
        orderIds: input.orderIds,
      });
      return { ...state, error };
    }
  }
}

export function describeWorkspaceCreateError(error: unknown) {
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

export function mergeRouteWorkspaces(
  serverWorkspaces: unknown,
  desktopWorkspaces: RouteWorkspace[],
): RouteWorkspace[] {
  const serverWorkspaceList = isOpenworkWorkspaceArray(serverWorkspaces) ? serverWorkspaces : [];
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
  const filteredServer = serverWorkspaceList.filter((workspace) => !remoteDesktopIds.has(workspace.id));

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

export function orderRouteWorkspaces(workspaces: RouteWorkspace[], orderIds: string[]): RouteWorkspace[] {
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

/**
 * Capture the first visible workspace order and extend it without letting the
 * server's active-workspace-first list reshuffle existing sidebar entries.
 * IDs that are temporarily absent stay in the preference so a transient
 * discovery gap cannot move them when they return.
 */
export function stabilizeRouteWorkspaceOrder(
  workspaces: RouteWorkspace[],
  orderIds: string[],
): { orderIds: string[]; workspaces: RouteWorkspace[] } {
  const stableOrderIds: string[] = [];
  const seenIds = new Set<string>();

  for (const value of orderIds) {
    const id = value.trim();
    if (!id || seenIds.has(id)) continue;
    stableOrderIds.push(id);
    seenIds.add(id);
  }

  for (const workspace of workspaces) {
    const id = workspace.id.trim();
    if (!id || seenIds.has(id)) continue;
    stableOrderIds.push(id);
    seenIds.add(id);
  }

  return {
    orderIds: stableOrderIds,
    workspaces: orderRouteWorkspaces(workspaces, stableOrderIds),
  };
}

export function toSessionGroups(
  workspaces: RouteWorkspace[],
  sessionsByWorkspaceId: Record<string, RouteSession[]>,
  errorsByWorkspaceId: Record<string, string | null>,
  loadingWorkspaceIds: Set<string>,
): WorkspaceSessionGroup[] {
  return workspaces.map((workspace) => ({
    workspace,
    sessions: sessionsByWorkspaceId[workspace.id] ?? [],
    status: loadingWorkspaceIds.has(workspace.id)
      ? "loading"
      : errorsByWorkspaceId[workspace.id]
        ? "error"
        : "ready",
    error: errorsByWorkspaceId[workspace.id],
  }));
}

export function isActiveSessionStatus(status: unknown) {
  return status === "running" || status === "retry" || status === "busy" || status === "streaming";
}

export function getSessionStatus(session: RouteSession | null | undefined) {
  const status = session?.status ?? session?.state ?? session?.runStatus ?? null;
  return typeof status === "string" ? status : normalizeSessionStatus(status);
}
