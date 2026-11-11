"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  remoteSessionReadResultSchema,
  type RemoteSessionAccessMode,
  type RemoteSessionAnswerInput,
  type RemoteSessionReadResult,
} from "@openwork/types/automations";
import {
  memberSessionListResponseSchema,
  organizationRemoteSessionSettingsResponseSchema,
  remoteSessionAttachResponseSchema,
  type MemberSessionListResponse,
  type OrganizationRemoteSessionSettingsResponse,
  type RemoteSessionAttachRequest,
  type RemoteSessionAttachResponse,
} from "@openwork/types/den/remote-sessions";
import { getErrorMessage, requestJson } from "../../../_lib/den-flow";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import { useOrgDashboard } from "../../_providers/org-dashboard-provider";
import { mergeLatestPage, type SessionView } from "./sessions-model";

/*
 * Every call here is scoped by Den to the signed-in member's own computers and
 * sessions. The page asks for nothing by member or computer owner, and only a
 * computer decides whether a session started on it may be reached.
 */

/** How often the list and an open session are read again while the tab is visible. */
export const SESSION_LIST_POLL_MS = 5_000;
export const SESSION_VIEW_POLL_MS = 4_000;
export const SESSION_PAGE_SIZE = 30;
/** A computer answers within about 20 seconds or Den hands back a request to collect; it expires after two minutes. */
const PENDING_POLL_MS = 2_000;
const PENDING_POLL_ATTEMPTS = 60;
const REQUEST_TIMEOUT_MS = 35_000;

/** A refusal with Den's code, e.g. `desktop_offline`, `stale_request`, `session_access_denied`. */
export class RemoteSessionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable = false) {
    super(message);
    this.name = "RemoteSessionError";
    this.code = code;
    this.retryable = retryable;
  }
}

export function remoteSessionErrorCode(error: unknown): string | null {
  return error instanceof RemoteSessionError ? error.code : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function request(orgId: string, method: "GET" | "POST" | "PATCH", path: string, body: unknown, fallback: string, signal?: AbortSignal): Promise<unknown> {
  const { response, payload } = await requestJson(path, {
    method,
    headers: { [ORG_SCOPE_HEADER]: orgId },
    cache: "no-store",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(signal ? { signal } : {}),
  }, REQUEST_TIMEOUT_MS).catch((failure: unknown) => {
    // The browser reports a dropped connection as a bare TypeError; say what happened instead.
    if (failure instanceof TypeError) throw new RemoteSessionError("network_error", "Couldn't reach OpenWork. Check your connection and try again.", true);
    throw failure;
  });
  const code = isRecord(payload) && typeof payload.error === "string" ? payload.error : null;
  if (response.ok && !code) return payload;
  const message = getErrorMessage(payload, response.status === 401 ? "Your session expired. Sign in again." : fallback);
  // A bare code is not a sentence to show; the caller's fallback is.
  throw new RemoteSessionError(code ?? `http_${response.status}`, message === code ? fallback : message, isRecord(payload) && payload.retryable === true);
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal?.reason); }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export type RemoteSessionCallOptions = {
  signal?: AbortSignal;
  /** Pause between collecting attempts while the computer has not answered. */
  pendingPollMs?: number;
};

/**
 * Runs one remote-session route. When the computer has not answered in time
 * Den returns `state: "pending"` with a requestId; the result is then collected
 * from the read route with that requestId until the computer answers or the
 * request expires.
 */
export async function callRemoteSession(
  orgId: string,
  action: "read" | "send" | "stop" | "answer",
  body: Record<string, unknown>,
  fallback: string,
  options: RemoteSessionCallOptions = {},
): Promise<Record<string, unknown>> {
  let payload = await request(orgId, "POST", `/v1/remote-sessions/${action}`, body, fallback, options.signal);
  for (let attempt = 0; isRecord(payload) && payload.state === "pending" && typeof payload.requestId === "string"; attempt += 1) {
    if (attempt >= PENDING_POLL_ATTEMPTS) throw new RemoteSessionError("desktop_request_pending", "That computer has not answered yet. Try again in a moment.", true);
    await wait(options.pendingPollMs ?? PENDING_POLL_MS, options.signal);
    payload = await request(orgId, "POST", "/v1/remote-sessions/read", { requestId: payload.requestId }, fallback, options.signal);
  }
  if (!isRecord(payload)) throw new RemoteSessionError("unexpected_response", fallback);
  return payload;
}

/** Where a session lives on its computer; both ids come from the member's own list. */
export type SessionLocation = { sessionId: string; workspaceId: string };

/** A page of the conversation, newest page first; `cursor` reads the page before an earlier one. */
export async function readRemoteSession(orgId: string, location: SessionLocation, cursor: string | null, options: RemoteSessionCallOptions = {}): Promise<RemoteSessionReadResult> {
  const payload = await callRemoteSession(orgId, "read", {
    sessionId: location.sessionId, workspaceId: location.workspaceId, from: "end", limit: SESSION_PAGE_SIZE, ...(cursor ? { cursor } : {}),
  }, "Couldn't load this session. Try again.", options);
  const parsed = remoteSessionReadResultSchema.safeParse(payload);
  if (!parsed.success) throw new RemoteSessionError("unexpected_response", "This session returned an unexpected response. Refresh to try again.");
  return parsed.data;
}

/** Sends a follow-up. Returns the id the computer gave the message, when it reports one. */
export async function sendRemoteSessionPrompt(orgId: string, location: SessionLocation, prompt: string, options: RemoteSessionCallOptions = {}): Promise<{ messageId: string | null }> {
  const payload = await callRemoteSession(orgId, "send", { sessionId: location.sessionId, workspaceId: location.workspaceId, prompt }, "Couldn't send your message. Try again.", options);
  return { messageId: typeof payload.messageId === "string" && payload.messageId ? payload.messageId : null };
}

export async function stopRemoteSession(orgId: string, location: SessionLocation, options: RemoteSessionCallOptions = {}): Promise<void> {
  await callRemoteSession(orgId, "stop", { sessionId: location.sessionId, workspaceId: location.workspaceId }, "Couldn't stop this session. Try again.", options);
}

export async function answerRemoteSession(orgId: string, location: SessionLocation, answer: RemoteSessionAnswerInput, options: RemoteSessionCallOptions = {}): Promise<void> {
  await callRemoteSession(orgId, "answer", { sessionId: location.sessionId, workspaceId: location.workspaceId, ...answer }, "Couldn't send your answer. Try again.", options);
}

/** Asks the computer to let this account's other devices reach a session that was started on it. The computer decides. */
export async function attachRemoteSession(orgId: string, target: RemoteSessionAttachRequest): Promise<RemoteSessionAttachResponse> {
  const fallback = "Couldn't connect. Try again.";
  const payload = await request(orgId, "POST", "/v1/remote-sessions/attach", { computerId: target.computerId, workspaceId: target.workspaceId, sessionId: target.sessionId }, fallback);
  const parsed = remoteSessionAttachResponseSchema.safeParse(payload);
  if (!parsed.success) throw new RemoteSessionError("unexpected_response", fallback);
  return parsed.data;
}

export async function fetchMySessions(orgId: string, signal?: AbortSignal): Promise<MemberSessionListResponse> {
  const payload = await request(orgId, "GET", "/v1/sessions", undefined, "Couldn't load your sessions. Try again.", signal);
  const parsed = memberSessionListResponseSchema.safeParse(payload);
  if (!parsed.success) throw new RemoteSessionError("unexpected_response", "Your sessions returned an unexpected response. Refresh to try again.");
  return parsed.data;
}

/** Cached per organization and member, never shared between them. */
export function mySessionsQueryKey(orgId: string, memberId: string): string[] {
  return ["my-sessions", orgId, memberId, "list"];
}

export function sessionViewQueryKey(orgId: string, memberId: string, commandId: string): string[] {
  return ["my-sessions", orgId, memberId, "view", commandId];
}

/** The member's sessions, read again every few seconds while the tab is visible and when it comes back. */
export function useMySessions(orgId: string, memberId: string, enabled: boolean) {
  return useQuery({
    queryKey: mySessionsQueryKey(orgId, memberId), enabled, retry: false, staleTime: 0,
    refetchInterval: SESSION_LIST_POLL_MS, refetchIntervalInBackground: false, refetchOnWindowFocus: true,
    queryFn: ({ signal }) => fetchMySessions(orgId, signal),
  });
}

/**
 * One open session: its newest page, merged into the messages already loaded.
 * `live` keeps reading while it works or waits and its computer is connected.
 */
export function useSessionView(orgId: string, memberId: string, commandId: string, location: SessionLocation | null, live: boolean) {
  const queryClient = useQueryClient();
  const queryKey = sessionViewQueryKey(orgId, memberId, commandId);
  return useQuery({
    queryKey, enabled: Boolean(location), retry: false, staleTime: 0,
    refetchInterval: live ? SESSION_VIEW_POLL_MS : false, refetchIntervalInBackground: false, refetchOnWindowFocus: true,
    queryFn: async ({ signal }): Promise<SessionView> => {
      if (!location) throw new RemoteSessionError("unknown_session", "This session is no longer in your list.");
      const read = await readRemoteSession(orgId, location, null, { signal });
      // Merged after the read, so earlier pages loaded meanwhile are kept.
      return mergeLatestPage(queryClient.getQueryData<SessionView>(queryKey), read);
    },
  });
}

// ─── Organization setting ────────────────────────────────────────────────────

const settingsPath = "/v1/org/remote-session-settings";

export function remoteSessionSettingsQueryKey(orgId: string): string[] {
  return ["org-remote-session-settings", orgId];
}

function parseSettings(payload: unknown): OrganizationRemoteSessionSettingsResponse {
  const parsed = organizationRemoteSessionSettingsResponseSchema.safeParse(payload);
  if (!parsed.success) throw new RemoteSessionError("unexpected_response", "This setting returned an unexpected response. Refresh to try again.");
  return parsed.data;
}

export async function fetchRemoteSessionSettings(orgId: string, signal?: AbortSignal): Promise<OrganizationRemoteSessionSettingsResponse> {
  return parseSettings(await request(orgId, "GET", settingsPath, undefined, "Couldn't load this setting. Try again.", signal));
}

export async function saveRemoteSessionSettings(orgId: string, access: RemoteSessionAccessMode): Promise<OrganizationRemoteSessionSettingsResponse> {
  return parseSettings(await request(orgId, "PATCH", settingsPath, { access }, "Couldn't save this setting. Try again."));
}

export function useRemoteSessionSettings(orgId: string, enabled: boolean) {
  return useQuery({
    queryKey: remoteSessionSettingsQueryKey(orgId), enabled, retry: false,
    queryFn: ({ signal }) => fetchRemoteSessionSettings(orgId, signal),
  });
}

export function useSaveRemoteSessionSettings(orgId: string) {
  const queryClient = useQueryClient();
  const { runReauthableAction } = useOrgDashboard();
  return useMutation({
    mutationKey: [...remoteSessionSettingsQueryKey(orgId), "save"], retry: false,
    mutationFn: async (access: RemoteSessionAccessMode): Promise<OrganizationRemoteSessionSettingsResponse> => {
      const result: { saved: OrganizationRemoteSessionSettingsResponse | null } = { saved: null };
      await runReauthableAction("save-remote-session-settings", async () => {
        result.saved = await saveRemoteSessionSettings(orgId, access);
      });
      if (!result.saved) throw new RemoteSessionError("not_saved", "Couldn't save this setting. Try again.");
      return result.saved;
    },
    onSuccess: (saved) => { queryClient.setQueryData(remoteSessionSettingsQueryKey(orgId), saved); },
  });
}
