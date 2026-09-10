import { createServer } from "node:http";
import { expect } from "vitest";
import { test } from "@openwork/testkit";
import { openworkContextSnapshotSchema } from "@openwork/types/openwork-context";
import { buildOpenworkContext } from "../../apps/app/src/react-app/shell/openwork-context-projector.ts";
import { resolveWorkspaceEndpoint } from "../../apps/app/src/app/lib/workspace-endpoint.ts";
import { listControlSessions, observedSessionAttention, sessionAttentionRevision } from "../../apps/app/src/react-app/domains/session/control/list-control-sessions.ts";
import { createQuestionReplyRegistry, MAX_QUESTION_REPLY_RECEIPTS, QUESTION_REPLY_RECEIPTS_KEY } from "../../apps/app/src/react-app/domains/session/control/question-reply-registry.ts";
import { sessionAttentionCacheIds, resolveSessionAttentionTarget, settleSessionAttentionQuestion, type SessionAttentionOwners } from "../../apps/app/src/react-app/domains/session/control/session-attention-owners.ts";
import { getReactQueryClient } from "../../apps/app/src/react-app/infra/query-client.ts";
import { questionKey } from "../../apps/app/src/react-app/domains/session/sync/session-sync.ts";
import { useSessionActivityStore } from "../../apps/app/src/react-app/domains/session/status/session-activity-store.ts";
import {
  createQuestionReplyReview, readSessionAttention, validateQuestionAnswers,
  type AttentionTarget, type QuestionReplyReview,
} from "../../apps/app/src/react-app/domains/session/control/session-attention.ts";

const question = {
  id: "question-b", sessionID: "session-b", questions: [{
    header: "Format", question: "Which format?", custom: false,
    options: [{ label: "Checklist", description: "Use a checklist" }, { label: "Outline", description: "Use an outline" }],
  }],
};

test("session inventory exposes cached typed waits even when error masks waiting; unseen is unknown, not idle", () => {
  const store = useSessionActivityStore.getState();
  store.setWaitingRequest("workspace", "session-b", "question", "q", true);
  store.setWaitingRequest("workspace", "session-b", "permission", "p", true);
  store.setError("workspace", "session-b", "synthetic private failure");
  const listed = listControlSessions({}, {
    workspaces: [{ id: "workspace" }, { id: "other" }], pinnedIds: [],
    sessionsByWorkspaceId: { workspace: [{ id: "session-b" }, { id: "unseen" }], other: [{ id: "session-b" }] },
    activityByWorkspaceId: useSessionActivityStore.getState().recordsByWorkspaceId,
    activityCacheIds: { workspace: "workspace", other: "other" },
  });
  expect(listed[0]).toMatchObject({ workspaceId: "workspace", activity: { freshness: "cached", status: "error", questions: 1, permissions: 1 } });
  for (const item of listed.slice(1)) expect(item.activity).toMatchObject({ freshness: "unknown", status: null, questions: null, permissions: null, observedAt: null, questionFreshness: "unknown", permissionFreshness: "unknown" });
  expect(JSON.stringify(listed)).not.toContain("synthetic private failure");
  const context = openworkContextSnapshotSchema.parse(buildOpenworkContext({
    route: "/workspace/workspace/session/unseen", revision: 1, capturedAt: new Date().toISOString(),
    workbench: { revision: 1, primary: { workspaceId: "workspace", sessionId: "unseen" }, secondary: null,
      focusedPane: "primary", sideChats: {}, tabs: listed.map(item => ({ workspaceId: item.workspaceId, sessionId: item.sessionId })) },
    ui: { sidebarOpen: true, sidePanelState: {}, applicationMenuVisible: false, workspaceRightSidebarExpanded: false },
    panelSessions: {}, pinnedSessionIds: [], availableAffordances: [],
    activityByWorkspaceId: useSessionActivityStore.getState().recordsByWorkspaceId,
    activityCacheIds: { workspace: "workspace", other: "other" },
  }));
  expect(context.resources.find(resource => resource.ref === "session:workspace:session-b")?.state.attention)
    .toEqual({ questionFreshness: "cached", permissionFreshness: "cached", questions: 1, permissions: 1 });
  expect(context.resources.find(resource => resource.ref === "session:other:session-b")?.state.attention)
    .toEqual({ questionFreshness: "unknown", permissionFreshness: "unknown", questions: null, permissions: null });
  expect(context.conversations.layout).toMatchObject({ kind: "single", sessionId: "unseen" });
  expect(JSON.stringify(context)).not.toContain("synthetic private failure");
  store.removeSession("workspace", "session-b");
});

test("question answer validation enforces exact labels, custom rules, multiplicity, and cardinality", () => {
  expect(() => validateQuestionAnswers(question, [["Checklist"]])).not.toThrow();
  for (const answers of [[], [["Checklist"], ["Outline"]], [[]], [["checklist"]], [["Checklist", "Outline"]], [[" "]]]) {
    expect(() => validateQuestionAnswers(question, answers)).toThrow();
  }
  const multiple = { ...question, questions: [{ ...question.questions[0], multiple: true, custom: true }] };
  expect(() => validateQuestionAnswers(multiple, [["Checklist", "Custom answer"]])).not.toThrow();
  expect(() => validateQuestionAnswers(multiple, [["Checklist", "Checklist"]])).toThrow();
  const ambiguous = { ...question, questions: [{ ...question.questions[0], options: [question.questions[0].options[0], question.questions[0].options[0]] }] };
  expect(() => validateQuestionAnswers(ambiguous, [["Checklist"]])).toThrow();
});

function receiptStorage() {
  const values = new Map<string, string>();
  const faults = { read: false, write: false, discard: false };
  let writes = 0;
  return { values, faults, writes: () => writes, storage: {
    getItem: (key: string) => { if (faults.read) throw new Error("Storage unavailable"); return values.get(key) ?? null; },
    setItem: (key: string, value: string) => { writes++; if (faults.write) throw new Error("Storage unavailable"); if (!faults.discard) values.set(key, value); },
  } };
}

test("run and transcript observations never imply observed zero waits; publisher changes only with projected attention", () => {
  const store = useSessionActivityStore.getState();
  const current = () => useSessionActivityStore.getState().recordsByWorkspaceId;
  const projection = () => observedSessionAttention(current().projection?.session);
  const empty = { questions: null, permissions: null, questionFreshness: "unknown", permissionFreshness: "unknown" };
  const initialRevision = sessionAttentionRevision(current());
  store.setRunStatus("projection", "session", "busy");
  store.observeTranscript("projection", "session", [{ id: "m", role: "assistant", parts: [{ type: "text", text: "Synthetic first token" }] }]);
  expect(projection()).toEqual(empty);
  expect(sessionAttentionRevision(current())).toBe(initialRevision);
  store.setWaitingRequest("projection", "session", "question", "q", true);
  const waitingRevision = sessionAttentionRevision(current());
  expect(waitingRevision).not.toBe(initialRevision);
  expect(projection()).toEqual({ ...empty, questions: 1, questionFreshness: "cached" });
  store.observeTranscript("projection", "session", [{ id: "m", role: "assistant", parts: [{ type: "text", text: "Synthetic second token" }] }]);
  expect(sessionAttentionRevision(current())).toBe(waitingRevision);
  store.setWaitingRequest("projection", "session", "question", "q", false);
  expect(projection()).toEqual(empty);
  expect(sessionAttentionRevision(current())).toBe(initialRevision);
  store.removeSession("projection", "session");
});

async function witness(engine: "v1" | "v2", run: (state: {
  target: AttentionTarget;
  posted: { path: string; body: unknown }[];
  state: { changed: boolean; nativeChanged: boolean; pending: boolean; uncertain: boolean; directory: string; hold: boolean; permissionOwner: string; permissionUnavailable: boolean; ownerDenied: boolean; holdReply: boolean };
  store: ReturnType<typeof receiptStorage>;
  registry: ReturnType<typeof createQuestionReplyRegistry>;
  releaseReply: () => void;
}) => Promise<void>) {
  const state = { changed: false, nativeChanged: false, pending: true, uncertain: false, directory: "/synthetic/remote", hold: false, permissionOwner: "session-c", permissionUnavailable: false, ownerDenied: false, holdReply: false };
  const store = receiptStorage();
  const registry = createQuestionReplyRegistry(() => store.storage);
  const replyWaiters: (() => void)[] = [];
  const releaseReply = () => { state.holdReply = false; replyWaiters.splice(0).forEach(release => release()); };
  const posted: { path: string; body: unknown }[] = [];
  const server = createServer(async (incoming, outgoing) => {
    const path = new URL(incoming.url ?? "/", "http://witness.invalid").pathname;
    let body = "";
    for await (const chunk of incoming) body += chunk;
    const respond = (payload: unknown, status = 200) => { outgoing.writeHead(status, { "Content-Type": "application/json" }); outgoing.end(JSON.stringify(payload)); };
    if (incoming.headers.authorization !== "Bearer synthetic-remote") return respond({}, 401);
    if (path === "/remote/experimental/engine-v2-preview/status") return respond({ enabled: engine === "v2", running: true, chatRouting: engine === "v2", mirroredProviderIds: [], skippedProviderIds: [], catalogModelIds: [] });
    const mount = `/remote/workspace/owner/${engine === "v2" ? "opencode2/api" : "opencode"}`;
    if (!path.startsWith(mount)) return respond({}, 404);
    const route = path.slice(mount.length);
    if (incoming.method === "POST") {
      posted.push({ path: route, body: JSON.parse(body) });
      if (state.holdReply) await new Promise<void>(resolve => replyWaiters.push(resolve));
      if (state.uncertain) { incoming.socket.destroy(); return; }
      state.pending = false;
      return respond(engine === "v2" ? { data: true } : true);
    }
    if (route === "/session/session-b") {
      if (state.ownerDenied) return respond({ code: "session_not_found" }, 404);
      const session = { id: "session-b", title: "Question task", directory: state.directory, location: { directory: state.directory }, time: { created: 1, updated: 1 } };
      return respond(engine === "v2" ? { data: session } : session);
    }
    if (route === "/question" || route === "/form/request") {
      if (state.hold) return;
      const questions = state.pending ? [{ ...question, questions: [{ ...question.questions[0], question: state.changed ? "Changed question" : "Which format?" }] }] : [];
      if (engine === "v1") return respond([...questions, { ...question, id: "question-other", sessionID: "other" }]);
      const forms = questions.map(request => ({ id: request.id, sessionID: request.sessionID, metadata: { kind: "question" }, fields: [{
        key: "format", type: "string", title: "Format", description: request.questions[0].question, custom: false,
        options: request.questions[0].options.map(option => ({ ...option, value: state.nativeChanged ? `changed-${option.label}` : `value-${option.label}` })),
      }] }));
      return respond({ data: [...forms, { ...forms[0], id: "generic-form", metadata: { kind: "form" } }] });
    }
    if (route.includes("permission") && state.permissionUnavailable) return respond({}, 503);
    if (route === "/permission") return respond([{ id: "permission-c", sessionID: state.permissionOwner, permission: "bash", metadata: { secret: "private-fixture" }, patterns: ["private-command"] }]);
    if (route === "/session/session-b/permission" || route === "/api/session/session-b/permission") return respond({ data: engine === "v2" && state.permissionOwner === "session-b"
      ? [{ id: "permission-c", sessionID: "session-b", action: "bash", metadata: { secret: "private-fixture" }, resources: ["private-command"] }] : [] });
    return respond({}, 404);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing witness address");
    const endpoint = resolveWorkspaceEndpoint({ id: "rem_owner", workspaceType: "remote", baseUrl: `http://127.0.0.1:${address.port}/remote`, openworkToken: "synthetic-remote",
      openworkHostUrl: null, openworkWorkspaceId: null, openworkClientToken: null, openworkHostToken: null }, { baseUrl: null, token: null });
    if (!endpoint) throw new Error("Missing owner endpoint");
    await run({ target: { workspaceId: "rem_owner", sessionId: "session-b", directory: "/synthetic/remote", endpoint }, posted, state, store, registry, releaseReply });
  } finally {
    releaseReply();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test("canonical remote activity and settlement never use desktop aliases; two-owner collisions remain quarantined", async () => witness("v1", async ({ target }) => {
  const workspace: SessionAttentionOwners["workspaces"][number] = {
    id: target.workspaceId, name: "Remote", displayNameResolved: "Remote", path: target.directory, workspaceType: "remote",
  };
  const other: SessionAttentionOwners["workspaces"][number] = {
    id: "owner", name: "Other", displayNameResolved: "Other", path: "/synthetic/other", workspaceType: "local",
  };
  const otherEndpoint = { ...target.endpoint, baseUrl: "https://other-owner.invalid", workspaceId: "other-runtime" };
  const input: SessionAttentionOwners = {
    workspaces: [workspace], cacheOwners: new Map(),
    endpointForWorkspace: value => value.id === workspace.id ? target.endpoint : value.id === other.id ? otherEndpoint : null,
  };
  const sessionId = "session-collision";
  const requestId = "question-collision";
  const query = getReactQueryClient();
  const activity = useSessionActivityStore.getState();
  const scopes = [target.endpoint.workspaceId, target.workspaceId, otherEndpoint.workspaceId];
  for (const scope of scopes) {
    activity.setWaitingRequest(scope, sessionId, "question", requestId, true);
    query.setQueryData(questionKey(scope, sessionId), [{ ...question, id: requestId, sessionID: sessionId }]);
  }
  activity.setWaitingRequest(target.workspaceId, sessionId, "question", "alias-only-question", true);
  const contextAttention = (cacheIds: Record<string, string | null>) => buildOpenworkContext({
    route: `/workspace/${workspace.id}/session/${sessionId}`, revision: 1, capturedAt: new Date().toISOString(),
    workbench: { revision: 1, primary: { workspaceId: workspace.id, sessionId }, secondary: null, focusedPane: "primary", sideChats: {}, tabs: [{ workspaceId: workspace.id, sessionId }] },
    ui: { sidebarOpen: true, sidePanelState: {}, applicationMenuVisible: false, workspaceRightSidebarExpanded: false },
    panelSessions: {}, pinnedSessionIds: [], availableAffordances: [], activityCacheIds: cacheIds,
    activityByWorkspaceId: useSessionActivityStore.getState().recordsByWorkspaceId,
  }).resources.find(resource => resource.kind === "session")?.state.attention;
  try {
    const cacheIds = sessionAttentionCacheIds(input);
    expect(cacheIds).toEqual({ rem_owner: "owner" });
    const listState = { workspaces: [workspace], sessionsByWorkspaceId: { [workspace.id]: [{ id: sessionId }] }, pinnedIds: [],
      activityCacheIds: cacheIds, activityByWorkspaceId: useSessionActivityStore.getState().recordsByWorkspaceId };
    expect(listControlSessions({}, listState)[0].activity).toMatchObject({ questions: 1, questionFreshness: "cached" });
    expect(contextAttention(cacheIds)).toMatchObject({ questions: 1, questionFreshness: "cached" });
    settleSessionAttentionQuestion(input, { ...target, sessionId }, requestId);
    expect(query.getQueryData(questionKey(target.endpoint.workspaceId, sessionId))).toEqual([]);
    for (const scope of [target.workspaceId, otherEndpoint.workspaceId]) {
      expect(query.getQueryData(questionKey(scope, sessionId))).toHaveLength(1);
      expect(query.getQueryData([...questionKey(scope, sessionId), "settled"])).toBeUndefined();
      expect(useSessionActivityStore.getState().recordsByWorkspaceId[scope][sessionId].waitingQuestionIds)
        .toEqual(scope === target.workspaceId ? [requestId, "alias-only-question"] : [requestId]);
    }
    activity.setWaitingRequest(target.endpoint.workspaceId, sessionId, "question", "second-question", true);
    input.workspaces = [workspace, other];
    const collided = sessionAttentionCacheIds(input);
    expect(collided).toEqual({ rem_owner: null, owner: null });
    expect(listControlSessions({}, { ...listState, activityCacheIds: collided })[0].activity).toMatchObject({ questions: null, questionFreshness: "unknown" });
    expect(contextAttention(collided)).toMatchObject({ questions: null, questionFreshness: "unknown" });
    expect(() => resolveSessionAttentionTarget(input, { workspaceId: workspace.id, sessionId })).toThrow(/ambiguous/);
    expect(() => settleSessionAttentionQuestion(input, { ...target, sessionId }, "second-question")).toThrow(/ambiguous/);
    expect(useSessionActivityStore.getState().recordsByWorkspaceId[target.endpoint.workspaceId][sessionId].waitingQuestionIds).toEqual(["second-question"]);
    expect(query.getQueryData(questionKey(otherEndpoint.workspaceId, sessionId))).toHaveLength(1);
    input.workspaces = [workspace];
    expect(sessionAttentionCacheIds(input)).toEqual({ rem_owner: null });
  } finally {
    for (const scope of scopes) {
      activity.removeSession(scope, sessionId);
      query.removeQueries({ queryKey: questionKey(scope, sessionId) });
    }
  }
}));

test("receipt storage read/write/discard failures and corruption fail closed before any submission", async () => witness("v1", async ({ target, posted }) => {
  const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: "synthetic-fingerprint", answers: [["Private answer"]] };
  const origin = { workspaceId: "origin", sessionId: "session-a", title: "Private title" };
  for (const fault of ["read", "write", "discard"] satisfies ("read" | "write" | "discard")[]) {
    const store = receiptStorage();
    store.faults[fault] = true;
    const registry = createQuestionReplyRegistry(() => store.storage);
    await expect(registry.reserve(target, args, origin)).rejects.toThrow(/storage|persist/);
    expect(posted).toEqual([]);
  }
  const corrupt = receiptStorage();
  corrupt.values.set(QUESTION_REPLY_RECEIPTS_KEY, "not valid json");
  await expect(createQuestionReplyRegistry(() => corrupt.storage).reserve(target, args, origin)).rejects.toThrow(/storage/);
  const store = receiptStorage();
  const registry = createQuestionReplyRegistry(() => store.storage);
  const receipt = await registry.reserve(target, args, origin);
  registry.ready(receipt.reviewId);
  registry.begin(receipt.reviewId);
  store.faults.write = true;
  expect(() => registry.submit(receipt.reviewId)).toThrow(/storage/);
  expect(posted).toEqual([]);
}));

test("receipts are bounded without evicting submission guards, and pending private reviews never survive reload", async () => witness("v1", async ({ target, posted, registry, store }) => {
  const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: "synthetic-fingerprint", answers: [["Private answer"]] };
  const origin = { workspaceId: "origin", sessionId: "session-a", title: "Private title" };
  const pending = await registry.reserve(target, args, origin);
  registry.ready(pending.reviewId);
  const writes = store.writes();
  const reloaded = createQuestionReplyRegistry(() => store.storage);
  expect(reloaded.receipt(pending.reviewId)).toMatchObject({ status: "cancelled", sent: false });
  expect(store.writes()).toBe(writes);
  const receipts = [];
  for (let index = 0; index < MAX_QUESTION_REPLY_RECEIPTS; index++) {
    const receipt = await reloaded.reserve(target, { ...args, requestId: `request-${index}` }, origin);
    reloaded.ready(receipt.reviewId);
    reloaded.begin(receipt.reviewId);
    reloaded.submit(receipt.reviewId);
    reloaded.finish(receipt.reviewId, index % 2 ? "unknown" : "accepted");
    receipts.push(receipt);
  }
  expect(() => reloaded.receipt(pending.reviewId)).toThrow(/unavailable/);
  await expect(reloaded.reserve(target, { ...args, requestId: "overflow" }, origin)).rejects.toThrow(/capacity/);
  const again = createQuestionReplyRegistry(() => store.storage);
  for (const receipt of receipts) expect(again.receipt(receipt.reviewId).status).toMatch(/accepted|unknown/);
  await expect(again.reserve(target, { ...args, requestId: "request-0", fingerprint: "changed" }, origin)).rejects.toThrow(/submission receipt/);
  expect(JSON.parse(store.values.get(QUESTION_REPLY_RECEIPTS_KEY) ?? "{}").receipts).toHaveLength(MAX_QUESTION_REPLY_RECEIPTS);
  expect(store.values.get(QUESTION_REPLY_RECEIPTS_KEY)).not.toMatch(/Private answer|Private title|answers|questions/);
  expect(posted).toEqual([]);
}));

for (const engine of ["v1", "v2"] satisfies ("v1" | "v2")[]) {
  test(`${engine}: server-accepted canonical and symlink directory spellings are not reinterpreted by the browser`, async () => witness(engine, async ({ target, state, posted, registry }) => {
    const attention = await readSessionAttention(target);
    const updates: QuestionReplyReview[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: value => updates.push(value), settled: () => {} });
    state.directory = "/private/var/synthetic/canonical-workspace";
    const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] };
    await review.propose(args, { workspaceId: "origin", sessionId: "session-a", title: "Private origin title" });
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.directory = "/resolved/symlink/workspace";
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("accepted");
    expect(posted).toHaveLength(1);
    state.ownerDenied = true;
    await expect(readSessionAttention(target)).rejects.toThrow();
    expect(posted).toHaveLength(1);
  }));

  test(`${engine}: closing and remounting cannot retry an unknown reply, and redacted status survives reload`, async () => witness(engine, async ({ target, posted, state, registry, store }) => {
    const attention = await readSessionAttention(target);
    const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] };
    const origin = { workspaceId: "origin", sessionId: "session-a", title: "Private origin title" };
    const updates: QuestionReplyReview[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: value => updates.push(value), settled: () => {} });
    const receipt = await review.propose(args, origin);
    const statusArgs = { reviewId: receipt.reviewId, workspaceId: target.workspaceId, sessionId: target.sessionId };
    expect(receipt).toMatchObject({ status: "loading", sent: false, origin: { workspaceId: "origin", sessionId: "session-a" }, target: { workspaceId: target.workspaceId, sessionId: target.sessionId } });
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.uncertain = true;
    await review.confirm();
    review.cancel();
    expect(updates.at(-1)?.status).toBe("unknown");
    review.dispose();
    const remounted = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: () => {}, settled: () => {} });
    await expect(remounted.propose(args, origin)).rejects.toThrow(/submission receipt/);
    const reloadedRegistry = createQuestionReplyRegistry(() => store.storage);
    const writes = store.writes();
    expect(await reloadedRegistry.status(statusArgs, target)).toMatchObject({ status: "unknown", sent: null, acceptance: "unknown", durability: "session" });
    expect(store.writes()).toBe(writes);
    await expect(reloadedRegistry.status({ ...statusArgs, workspaceId: "wrong" }, target)).rejects.toThrow();
    await expect(reloadedRegistry.status({ ...statusArgs, sessionId: "wrong" }, target)).rejects.toThrow();
    await expect(reloadedRegistry.status(statusArgs, { ...target, endpoint: { ...target.endpoint, baseUrl: "https://different-owner.invalid" } })).rejects.toThrow();
    const reloaded = createQuestionReplyReview({ registry: reloadedRegistry, resolveTarget: () => target, changed: () => {}, settled: () => {} });
    await expect(reloaded.propose({ ...args, fingerprint: "changed-content" }, origin)).rejects.toThrow(/submission receipt/);
    const decorated = new URL(target.endpoint.baseUrl);
    decorated.username = "synthetic-user";
    decorated.password = "synthetic-private";
    decorated.search = "?credential=synthetic-credential";
    const alias = { ...target, workspaceId: "rem_alias", endpoint: { ...target.endpoint, baseUrl: decorated.href } };
    await expect(reloadedRegistry.reserve(alias, { ...args, workspaceId: alias.workspaceId }, origin)).rejects.toThrow(/submission receipt/);
    expect(posted).toHaveLength(1);
    const saved = store.values.get(QUESTION_REPLY_RECEIPTS_KEY);
    expect(saved).toContain(receipt.reviewId);
    expect(saved).not.toMatch(/Checklist|Which format|Private origin title|synthetic-remote|synthetic-private|synthetic-credential|127\.0\.0\.1|\/synthetic\/remote/);
  }));

  test(`${engine}: an in-flight POST stays guarded across new controllers and reload; cleanup errors cannot erase acceptance`, async () => witness(engine, async ({ target, posted, state, registry, store, releaseReply }) => {
    const attention = await readSessionAttention(target);
    const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] };
    const origin = { workspaceId: "origin", sessionId: "session-a", title: "Origin" };
    const updates: QuestionReplyReview[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: value => updates.push(value), settled: () => { throw new Error("Synthetic cache cleanup failure"); } });
    const receipt = await review.propose(args, origin);
    const statusArgs = { reviewId: receipt.reviewId, workspaceId: target.workspaceId, sessionId: target.sessionId };
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.holdReply = true;
    const sending = review.confirm();
    await expect.poll(() => posted.length).toBe(1);
    review.dispose();
    expect(await registry.status(statusArgs, target)).toMatchObject({ status: "sending", sent: null, acceptance: "unknown" });
    const remounted = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: () => {}, settled: () => {} });
    await expect(remounted.propose(args, origin)).rejects.toThrow(/submission receipt/);
    const reloadedRegistry = createQuestionReplyRegistry(() => store.storage);
    const writes = store.writes();
    expect(await reloadedRegistry.status(statusArgs, target)).toMatchObject({ status: "unknown", sent: null });
    expect(store.writes()).toBe(writes);
    await expect(reloadedRegistry.reserve(target, args, origin)).rejects.toThrow(/submission receipt/);
    releaseReply();
    await sending;
    expect(await registry.status(statusArgs, target)).toMatchObject({ status: "accepted", sent: true, acceptance: "accepted" });
    expect(updates.at(-1)?.status).toBe("accepted");
    review.cancel();
    expect(await registry.status(statusArgs, target)).toMatchObject({ status: "accepted", sent: true });
    const nextReload = createQuestionReplyRegistry(() => store.storage);
    expect(await nextReload.status(statusArgs, target)).toMatchObject({ status: "accepted", sent: true });
    expect(posted).toHaveLength(1);
  }));

  test(`${engine}: storage failure before submission blocks POST; failure after acceptance preserves the known outcome`, async () => witness(engine, async ({ target, posted, state, registry, store, releaseReply }) => {
    const attention = await readSessionAttention(target);
    const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] };
    const origin = { workspaceId: "origin", sessionId: "session-a", title: "Origin" };
    const updates: QuestionReplyReview[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: value => updates.push(value), settled: () => {} });
    const receipt = await review.propose(args, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    store.faults.write = true;
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("rejected");
    expect(registry.receipt(receipt.reviewId)).toMatchObject({ status: "rejected", sent: false, durability: "memory" });
    expect(posted).toEqual([]);
    store.faults.write = false;
    await expect(review.propose(args, origin)).rejects.toThrow(/storage/);
    // A separate clean browser session exercises a post-response storage failure.
    const secondStore = receiptStorage();
    const secondRegistry = createQuestionReplyRegistry(() => secondStore.storage);
    const secondReview = createQuestionReplyReview({ registry: secondRegistry, resolveTarget: () => target, changed: value => updates.push(value), settled: () => {} });
    const secondReceipt = await secondReview.propose(args, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.holdReply = true;
    const sending = secondReview.confirm();
    await expect.poll(() => posted.length).toBe(1);
    secondStore.faults.write = true;
    releaseReply();
    await sending;
    expect(secondRegistry.receipt(secondReceipt.reviewId)).toMatchObject({ status: "accepted", acceptance: "accepted", sent: true, durability: "memory" });
    secondStore.faults.write = false;
    const reload = createQuestionReplyRegistry(() => secondStore.storage);
    expect(reload.receipt(secondReceipt.reviewId)).toMatchObject({ status: "unknown", sent: null });
    await expect(reload.reserve(target, args, origin)).rejects.toThrow(/submission receipt/);
    expect(posted).toHaveLength(1);
  }));

  test(`${engine}: permission summaries redact resource bodies and failed permission reads stay unknown without hiding questions`, async () => witness(engine, async ({ target, posted, state }) => {
    state.permissionOwner = "session-b";
    const attention = await readSessionAttention(target);
    expect(attention.permissions).toMatchObject({ freshness: "fresh", items: [{ requestId: "permission-c", permission: "bash" }] });
    expect(JSON.stringify(attention)).not.toMatch(/synthetic-remote|private-fixture|private-command/);
    state.permissionUnavailable = true;
    const partial = await readSessionAttention(target);
    expect(partial.questions.items).toHaveLength(1);
    expect(partial.permissions).toEqual({ freshness: "unknown", observedAt: null, items: [] });
    expect(posted).toEqual([]);
  }));

  test(`${engine}: owner-routed attention and review never send until the person confirms, then send once`, async () => witness(engine, async ({ target, posted, registry }) => {
    const attention = await readSessionAttention(target);
    expect(attention.questions.items).toHaveLength(1);
    expect(attention.questions.items[0]).toMatchObject({ requestId: question.id, sessionId: "session-b" });
    expect(attention.permissions).toMatchObject({ freshness: "fresh", items: [] });
    expect(JSON.stringify(attention)).not.toMatch(/synthetic-remote|private-fixture|private-command|generic-form|question-other/);
    const updates: QuestionReplyReview[] = [];
    const settlements: string[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: value => updates.push(value), settled: (_, id) => settlements.push(id) });
    const receipt = await review.propose({ workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] }, { workspaceId: "origin", sessionId: "session-a", title: "Origin task" });
    expect(receipt).toMatchObject({ status: "loading", sent: false, acceptance: "not_sent" });
    expect(updates[0].status).toBe("loading");
    expect(posted).toEqual([]);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    expect(posted).toEqual([]);
    await Promise.all([review.confirm(), review.confirm()]);
    expect(updates.at(-1)?.status).toBe("accepted");
    expect(settlements).toEqual([question.id]);
    expect(posted).toEqual([engine === "v1"
      ? { path: "/question/question-b/reply", body: { answers: [["Checklist"]] } }
      : { path: "/session/session-b/form/question-b/reply", body: { answer: { format: "value-Checklist" } } }]);
  }));

  test(`${engine}: changed, stale, wrong-owner, and permission IDs reject without a write; uncertain writes never retry`, async () => witness(engine, async ({ target, posted, state, registry }) => {
    const attention = await readSessionAttention(target);
    const args = { workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] };
    const origin = { workspaceId: "origin", sessionId: "session-a", title: "Origin task" };
    const updates: QuestionReplyReview[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: value => {
      if (value.workspaceId !== target.workspaceId) throw new Error("Unknown workspace");
      return target;
    }, changed: value => updates.push(value), settled: () => { throw new Error("Must not settle uncertain replies"); } });
    await expect(review.propose({ ...args, workspaceId: "wrong" }, origin)).rejects.toThrow();
    await expect(review.propose({ ...args, confirmed: true }, origin)).rejects.toThrow();
    await review.propose({ ...args, requestId: "permission-c" }, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("rejected");
    await review.propose(args, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.changed = true;
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("rejected");
    state.changed = false;
    await review.propose(args, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.ownerDenied = true;
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("rejected");
    state.ownerDenied = false;
    if (engine === "v2") {
      await review.propose(args, origin);
      await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
      state.nativeChanged = true;
      await review.confirm();
      expect(updates.at(-1)?.status).toBe("rejected");
      state.nativeChanged = false;
    }
    await review.propose(args, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.pending = false;
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("rejected");
    expect(posted).toEqual([]);
    state.pending = true;
    await review.propose(args, origin);
    await expect.poll(() => updates.at(-1)?.status).toBe("pending_review");
    state.uncertain = true;
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("unknown");
    await review.confirm();
    await expect(review.propose(args, origin)).rejects.toThrow(/submission receipt/);
    expect(posted).toHaveLength(1);
  }));

  test(`${engine}: a stalled question read still returns a loading receipt promptly and cancellation prevents sending`, async () => witness(engine, async ({ target, posted, state, registry }) => {
    const attention = await readSessionAttention(target);
    state.hold = true;
    const updates: QuestionReplyReview[] = [];
    const review = createQuestionReplyReview({ registry, resolveTarget: () => target, changed: value => updates.push(value), settled: () => {} });
    const start = Date.now();
    const receipt = await review.propose({ workspaceId: target.workspaceId, sessionId: target.sessionId, requestId: question.id, fingerprint: attention.questions.items[0].fingerprint, answers: [["Checklist"]] }, { workspaceId: "origin", sessionId: "session-a", title: "Origin task" });
    expect(Date.now() - start).toBeLessThan(100);
    expect(receipt.sent).toBe(false);
    review.cancel();
    await review.confirm();
    expect(updates.at(-1)?.status).toBe("cancelled");
    expect(posted).toEqual([]);
  }));
}
