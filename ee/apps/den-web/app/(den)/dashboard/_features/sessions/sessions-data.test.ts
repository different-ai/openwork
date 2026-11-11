import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemberSessionListResponse } from "@openwork/types/den/remote-sessions";
import { ORG_SCOPE_HEADER } from "../../../_lib/org-scope";
import {
  RemoteSessionError,
  answerRemoteSession,
  attachRemoteSession,
  fetchMySessions,
  fetchRemoteSessionSettings,
  mySessionsQueryKey,
  readRemoteSession,
  remoteSessionSettingsQueryKey,
  saveRemoteSessionSettings,
  sendRemoteSessionPrompt,
  sessionViewQueryKey,
  stopRemoteSession,
} from "./sessions-data";
import { dismissAnswer, permissionAnswer, questionsAnswer } from "./sessions-model";

type Call = { path: string; method: string | undefined; org: string | null; body: unknown };

/** Answers each request with the next reply and records what was sent. */
async function withDen<T>(replies: Array<{ status?: number; body: unknown }>, run: () => Promise<T>): Promise<{ calls: Call[]; result: T }> {
  const originalFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    const reply = replies[calls.length] ?? replies.at(-1);
    calls.push({
      path: new URL(String(input), "http://den.test").pathname,
      method: init?.method,
      org: new Headers(init?.headers).get(ORG_SCOPE_HEADER),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json(reply?.body ?? {}, { status: reply?.status ?? 200 });
  };
  try {
    return { result: await run(), calls };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function failure(run: () => Promise<unknown>): Promise<RemoteSessionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RemoteSessionError) return error;
    throw error;
  }
  throw new Error("Expected the call to fail.");
}

const location = { sessionId: "ses_1", workspaceId: "ws_1" };
const page = {
  target: "desktop", requestId: "rsr_1", sessionId: "ses_1", workspaceId: "ws_1", state: "done",
  title: "Update the release notes", status: "waiting", waitingFor: "permission", lastError: null, messageCount: 1, from: "end",
  messages: [{ id: "msg_1", role: "user", createdAt: 1, text: "Update the notes", truncated: false, toolCalls: [], error: null }],
  nextCursor: null,
  pending: { kind: "permission", requestId: "per_1", title: "Run pnpm test", detail: "" },
  pendingItems: [{ kind: "permission", requestId: "per_1", title: "Run pnpm test", detail: "" }],
};
const list: MemberSessionListResponse = {
  ceiling: "created",
  computers: [{ computerId: "cmp_1", label: "Work laptop", platform: "darwin", online: true, lastSeenAt: 1, supportsAccess: true, access: "created", effectiveAccess: "created", sessionsUpdatedAt: null }],
  sessions: [],
};

test("the list is the member's own, scoped to the organization on screen", async () => {
  const { calls, result } = await withDen([{ body: list }], () => fetchMySessions("org_1"));
  assert.deepEqual(calls, [{ path: "/v1/sessions", method: "GET", org: "org_1", body: undefined }]);
  assert.deepEqual(result, list);
  const invalid = await failure(async () => (await withDen([{ body: { sessions: "nope" } }], () => fetchMySessions("org_1"))).result);
  assert.equal(invalid.code, "unexpected_response");
  assert.notDeepEqual(mySessionsQueryKey("org_a", "om_1"), mySessionsQueryKey("org_a", "om_2"));
  assert.notDeepEqual(mySessionsQueryKey("org_a", "om_1"), mySessionsQueryKey("org_b", "om_1"));
  assert.notDeepEqual(sessionViewQueryKey("org_a", "om_1", "cmd_1"), sessionViewQueryKey("org_a", "om_1", "cmd_2"));
  assert.notDeepEqual(mySessionsQueryKey("org_a", "om_1"), sessionViewQueryKey("org_a", "om_1", "cmd_1").slice(0, 4));
});

test("a session is read from its end, thirty messages at a time, and earlier with the cursor", async () => {
  const latest = await withDen([{ body: page }], () => readRemoteSession("org_1", location, null));
  assert.deepEqual(latest.calls, [{ path: "/v1/remote-sessions/read", method: "POST", org: "org_1", body: { sessionId: "ses_1", workspaceId: "ws_1", from: "end", limit: 30 } }]);
  assert.equal(latest.result.title, "Update the release notes");
  assert.equal(latest.result.pendingItems?.[0]?.requestId, "per_1");
  const earlier = await withDen([{ body: page }], () => readRemoteSession("org_1", location, "msg_1"));
  assert.deepEqual(earlier.calls[0]?.body, { sessionId: "ses_1", workspaceId: "ws_1", from: "end", limit: 30, cursor: "msg_1" });
});

test("a computer that has not answered yet is collected by requestId until it has", async () => {
  const pending = { target: "desktop", requestId: "rsr_9", sessionId: "ses_1", workspaceId: "ws_1", action: "read", state: "pending" };
  const { calls, result } = await withDen([{ body: pending }, { body: pending }, { body: page }], () => readRemoteSession("org_1", location, null, { pendingPollMs: 0 }));
  assert.deepEqual(calls.map((call) => [call.path, call.body]), [
    ["/v1/remote-sessions/read", { sessionId: "ses_1", workspaceId: "ws_1", from: "end", limit: 30 }],
    ["/v1/remote-sessions/read", { requestId: "rsr_9" }],
    ["/v1/remote-sessions/read", { requestId: "rsr_9" }],
  ]);
  assert.equal(result.messages.length, 1);

  // A send, stop or answer that is still pending is collected the same way, and its failure is reported.
  const expired = await failure(async () => (await withDen([
    { body: { ...pending, action: "answer" } },
    { status: 503, body: { error: "desktop_request_expired", message: "The desktop did not answer in time.", retryable: true } },
  ], () => answerRemoteSession("org_1", location, permissionAnswer("per_1", "once"), { pendingPollMs: 0 }))).result);
  assert.equal(expired.code, "desktop_request_expired");
  assert.equal(expired.retryable, true);
});

test("follow-up, stop and each kind of answer send exactly their payload", async () => {
  const accepted = { target: "desktop", state: "accepted", messageId: "msg_2", alreadyPresent: false };
  const sent = await withDen([{ body: accepted }], () => sendRemoteSessionPrompt("org_1", location, "Also update the changelog"));
  assert.deepEqual(sent.calls, [{ path: "/v1/remote-sessions/send", method: "POST", org: "org_1", body: { sessionId: "ses_1", workspaceId: "ws_1", prompt: "Also update the changelog" } }]);
  assert.deepEqual(sent.result, { messageId: "msg_2" });

  const stopped = await withDen([{ body: { target: "desktop", stopped: true, reason: null } }], () => stopRemoteSession("org_1", location));
  assert.deepEqual(stopped.calls, [{ path: "/v1/remote-sessions/stop", method: "POST", org: "org_1", body: { sessionId: "ses_1", workspaceId: "ws_1" } }]);

  const answered = { target: "desktop", state: "answered", answeredRequestId: "per_1", alreadyAnswered: false };
  const answers = [permissionAnswer("per_1", "once"), permissionAnswer("per_1", "reject"), questionsAnswer("que_1", [["main"], ["dev", "lint"]]), dismissAnswer("que_1")];
  const bodies: unknown[] = [];
  for (const answer of answers) {
    const { calls } = await withDen([{ body: answered }], () => answerRemoteSession("org_1", location, answer));
    assert.equal(calls[0]?.path, "/v1/remote-sessions/answer");
    bodies.push(calls[0]?.body);
  }
  assert.deepEqual(bodies, [
    { sessionId: "ses_1", workspaceId: "ws_1", kind: "permission", requestId: "per_1", decision: "once" },
    { sessionId: "ses_1", workspaceId: "ws_1", kind: "permission", requestId: "per_1", decision: "reject" },
    { sessionId: "ses_1", workspaceId: "ws_1", kind: "question", requestId: "que_1", answers: [["main"], ["dev", "lint"]] },
    { sessionId: "ses_1", workspaceId: "ws_1", kind: "dismiss", requestId: "que_1" },
  ]);
  assert.doesNotMatch(JSON.stringify(bodies), /always/);
});

test("a refusal keeps Den's code and message", async () => {
  const stale = await failure(async () => (await withDen([{ status: 409, body: { error: "stale_request", message: "That request is no longer pending.", retryable: false } }],
    () => answerRemoteSession("org_1", location, dismissAnswer("que_1")))).result);
  assert.equal(stale.code, "stale_request");
  assert.equal(stale.retryable, false);
  const offline = await failure(async () => (await withDen([{ status: 503, body: { error: "desktop_offline", message: "The client that runs this session is not connected.", retryable: true } }],
    () => readRemoteSession("org_1", location, null))).result);
  assert.equal(offline.code, "desktop_offline");
  assert.equal(offline.message, "The client that runs this session is not connected.");
  // A code alone is not a sentence: the page says what it could not do.
  const bare = await failure(async () => (await withDen([{ status: 404, body: { error: "unknown_session" } }], () => stopRemoteSession("org_1", location))).result);
  assert.equal(bare.code, "unknown_session");
  assert.equal(bare.message, "Couldn't stop this session. Try again.");
  // A dropped connection reads as one, not as the browser's own error text.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
  try {
    const dropped = await failure(() => sendRemoteSessionPrompt("org_1", location, "Hello"));
    assert.equal(dropped.code, "network_error");
    assert.equal(dropped.message, "Couldn't reach OpenWork. Check your connection and try again.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Connect names the computer, workspace and session, and reports why it was refused", async () => {
  const attached = { target: "desktop", state: "attached", commandId: "cmd_7", computerId: "cmp_1", workspaceId: "ws_1", sessionId: "ses_1", expiresAt: null };
  const target = { computerId: "cmp_1", workspaceId: "ws_1", sessionId: "ses_1" };
  const { calls, result } = await withDen([{ body: attached }], () => attachRemoteSession("org_1", target));
  assert.deepEqual(calls, [{ path: "/v1/remote-sessions/attach", method: "POST", org: "org_1", body: target }]);
  assert.equal(result.state, "attached");
  assert.equal(result.commandId, "cmd_7");
  const queued = await withDen([{ body: { ...attached, state: "queued", expiresAt: 5 } }], () => attachRemoteSession("org_1", target));
  assert.equal(queued.result.state, "queued");
  for (const code of ["feature_disabled", "unknown_computer", "desktop_offline", "desktop_update_required", "session_access_denied", "session_unavailable"]) {
    const refused = await failure(async () => (await withDen([{ status: 409, body: { error: code, message: `Refused: ${code}` } }], () => attachRemoteSession("org_1", target))).result);
    assert.equal(refused.code, code);
    assert.equal(refused.message, `Refused: ${code}`);
  }
});

test("the organization setting is read and saved as one access value", async () => {
  const settings = { settings: { access: "created" }, canEdit: true };
  const loaded = await withDen([{ body: settings }], () => fetchRemoteSessionSettings("org_1"));
  assert.deepEqual(loaded.calls, [{ path: "/v1/org/remote-session-settings", method: "GET", org: "org_1", body: undefined }]);
  assert.deepEqual(loaded.result, settings);
  const saved = await withDen([{ body: { settings: { access: "all" }, canEdit: true } }], () => saveRemoteSessionSettings("org_1", "all"));
  assert.deepEqual(saved.calls, [{ path: "/v1/org/remote-session-settings", method: "PATCH", org: "org_1", body: { access: "all" } }]);
  assert.equal(saved.result.settings.access, "all");
  const forbidden = await failure(async () => (await withDen([{ status: 403, body: { error: "forbidden", message: "You cannot edit organization settings." } }], () => saveRemoteSessionSettings("org_1", "all"))).result);
  assert.equal(forbidden.message, "You cannot edit organization settings.");
  assert.notDeepEqual(remoteSessionSettingsQueryKey("org_a"), remoteSessionSettingsQueryKey("org_b"));
});
