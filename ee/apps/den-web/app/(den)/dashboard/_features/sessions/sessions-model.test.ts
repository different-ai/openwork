import assert from "node:assert/strict";
import { test } from "node:test";
import type { RemoteSessionPending, RemoteSessionReadResult, RemoteSessionTranscriptMessage } from "@openwork/types/automations";
import { remoteSessionAnswerInputSchema } from "@openwork/types/automations";
import type { MemberSession } from "@openwork/types/den/remote-sessions";
import {
  ATTACH_FAILED_MESSAGE,
  appendSentMessage,
  attachAnswered,
  attachDismissed,
  attachOutcome,
  attachRefused,
  attachRequested,
  computerAccessNote,
  dismissAnswer,
  groupSessions,
  lostAttachFailure,
  mergeEarlierPage,
  mergeLatestPage,
  pendingItemsOf,
  pendingSummaryLine,
  permissionAnswer,
  questionAnswer,
  questionAnswers,
  questionsAnswer,
  sessionIdentity,
  sessionStateBadge,
  setQuestionCustom,
  settleAttachAttempts,
  toggleQuestionOption,
  toolStatusLabel,
  transcriptSteps,
  type PendingQuestion,
  type QuestionDraft,
} from "./sessions-model";

const session = (overrides: Partial<MemberSession>): MemberSession => ({
  key: "k", computerId: "cmp_1", computerLabel: "Work laptop", workspaceId: "ws_1", workspaceName: "Docs", sessionId: "ses_1", title: "Task",
  origin: "remote", reach: "reachable", commandId: "cmd_1", state: "idle", waitingFor: null, pending: null, latestStep: null, updatedAt: new Date(1000).toISOString(), ...overrides,
});

test("each computer says why it reaches less than chosen, or where to change it", () => {
  assert.equal(computerAccessNote({ supportsAccess: false, access: "created", effectiveAccess: "created" }, "all"), "Update OpenWork on this computer to choose.");
  assert.equal(computerAccessNote({ supportsAccess: true, access: "all", effectiveAccess: "created" }, "created"), "Your organization only allows sessions started remotely.");
  assert.equal(computerAccessNote({ supportsAccess: true, access: "created", effectiveAccess: "created" }, "all"), "Change this in Settings › Devices on that computer.");
  assert.equal(computerAccessNote({ supportsAccess: true, access: "created", effectiveAccess: "created" }, "created"), "Your organization only allows sessions started remotely.");
  assert.equal(computerAccessNote({ supportsAccess: true, access: "all", effectiveAccess: "all" }, "all"), null);
});

test("sessions that need the member come first, then the rest, newest first", () => {
  const { needsYou, rest } = groupSessions([
    session({ key: "old", updatedAt: new Date(10).toISOString() }),
    session({ key: "waiting-old", state: "waiting", updatedAt: new Date(5).toISOString() }),
    session({ key: "never", updatedAt: null }),
    session({ key: "new", state: "running", updatedAt: new Date(30).toISOString() }),
    session({ key: "waiting-new", state: "waiting", updatedAt: new Date(20).toISOString() }),
  ]);
  assert.deepEqual(needsYou.map((entry) => entry.key), ["waiting-new", "waiting-old"]);
  assert.deepEqual(rest.map((entry) => entry.key), ["new", "old", "never"]);
});

test("session ordering compares RFC 3339 instants rather than timestamp text", () => {
  const { rest } = groupSessions([
    session({ key: "older", updatedAt: "2026-11-11T13:00:00+02:00" }),
    session({ key: "newer", updatedAt: "2026-11-11T12:00:00Z" }),
    session({ key: "never", updatedAt: null }),
  ]);
  assert.deepEqual(rest.map((entry) => entry.key), ["newer", "older", "never"]);
});

test("every state has its badge and an unreported one has none", () => {
  assert.deepEqual(["starting", "running", "waiting", "idle", "error"].map((state) => sessionStateBadge(state as MemberSession["state"])?.label), ["Starting", "Working", "Needs you", "Idle", "Error"]);
  assert.equal(sessionStateBadge("unknown"), null);
});

test("a waiting row says what it waits for in one line", () => {
  assert.equal(pendingSummaryLine({ kind: "permission", requestId: "per_1", title: "Run pnpm test" }), "Run pnpm test");
  assert.equal(pendingSummaryLine({ kind: "question", requestId: "que_1", question: "Which branch?", options: ["main"], multiple: false, custom: false, questionCount: 1 }), "Which branch?");
  assert.equal(pendingSummaryLine(null), null);
});

test("a queued Connect is settled only by a list read after it", () => {
  const queued = { phase: "queued", since: 100 } as const;
  const local = session({ origin: "local", reach: "attachable", commandId: null });
  assert.deepEqual(attachOutcome({ phase: "requesting" }, local, 500), { kind: "waiting" });
  // The list on screen is older than the attach: it says nothing yet.
  assert.deepEqual(attachOutcome(queued, local, 100), { kind: "waiting" });
  assert.deepEqual(attachOutcome(queued, session({ origin: "local", reach: "connecting", commandId: "cmd_9" }), 200), { kind: "waiting" });
  assert.deepEqual(attachOutcome(queued, session({ origin: "local", reach: "reachable", commandId: "cmd_9" }), 200), { kind: "open", commandId: "cmd_9" });
  assert.deepEqual(attachOutcome(queued, local, 200), { kind: "failed", message: ATTACH_FAILED_MESSAGE });
  assert.deepEqual(attachOutcome(queued, null, 200), { kind: "failed", message: ATTACH_FAILED_MESSAGE });
  assert.equal(ATTACH_FAILED_MESSAGE, "Couldn't connect. Try again.");
  assert.deepEqual(attachOutcome({ phase: "failed", message: "That computer is offline." }, local, 200), { kind: "failed", message: "That computer is offline." });
});

test("a permission is answered once or rejected, never always", () => {
  assert.deepEqual(permissionAnswer("per_1", "once"), { kind: "permission", requestId: "per_1", decision: "once" });
  assert.deepEqual(permissionAnswer("per_1", "reject"), { kind: "permission", requestId: "per_1", decision: "reject" });
  assert.deepEqual(dismissAnswer("que_1"), { kind: "dismiss", requestId: "que_1" });
  for (const answer of [permissionAnswer("per_1", "once"), permissionAnswer("per_1", "reject"), dismissAnswer("que_1"), questionsAnswer("que_1", [["main"]])]) {
    assert.ok(remoteSessionAnswerInputSchema.safeParse(answer).success);
  }
  assert.ok(!remoteSessionAnswerInputSchema.safeParse({ kind: "permission", requestId: "per_1", decision: "always" }).success);
});

const options = [{ label: "main", description: "The default branch" }, { label: "dev", description: "" }];
const single: PendingQuestion = { header: "Branch", question: "Which branch?", options, multiple: false, custom: false };
const multiple: PendingQuestion = { header: "Checks", question: "Which checks?", options, multiple: true, custom: true };
const openEnded: PendingQuestion = { header: "Name", question: "What should it be called?", options: [], multiple: false, custom: true };
const empty: QuestionDraft = { selected: [], custom: "" };

test("a single-choice question keeps one option, or the typed answer instead", () => {
  const picked = toggleQuestionOption(single, empty, "main");
  assert.deepEqual(questionAnswer(single, picked), ["main"]);
  assert.deepEqual(questionAnswer(single, toggleQuestionOption(single, picked, "dev")), ["dev"]);
  assert.equal(questionAnswer(single, empty), null);
  assert.equal(questionAnswer(single, undefined), null);
  // Labels the question never offered and text it did not ask for are not sent.
  assert.equal(questionAnswer(single, { selected: ["prod"], custom: "anything" }), null);

  const withOther: PendingQuestion = { ...single, custom: true };
  const typed = setQuestionCustom(withOther, picked, "  release/1.2  ");
  assert.deepEqual(typed.selected, []);
  assert.deepEqual(questionAnswer(withOther, typed), ["release/1.2"]);
  assert.deepEqual(questionAnswer(withOther, toggleQuestionOption(withOther, typed, "dev")), ["dev"]);
  assert.equal(questionAnswer(withOther, { selected: [], custom: "   " }), null);
  assert.deepEqual(questionAnswer(openEnded, { selected: [], custom: "Atlas" }), ["Atlas"]);
});

test("a multiple-choice question sends every pick in the question's order, plus the typed answer", () => {
  let draft = toggleQuestionOption(multiple, empty, "dev");
  draft = toggleQuestionOption(multiple, draft, "main");
  assert.deepEqual(questionAnswer(multiple, draft), ["main", "dev"]);
  draft = setQuestionCustom(multiple, draft, "lint");
  assert.deepEqual(questionAnswer(multiple, draft), ["main", "dev", "lint"]);
  draft = toggleQuestionOption(multiple, draft, "main");
  assert.deepEqual(questionAnswer(multiple, draft), ["dev", "lint"]);
  assert.equal(questionAnswer(multiple, empty), null);
});

test("an answer is ready only when every question has one, in order", () => {
  const questions = [single, multiple, openEnded];
  assert.equal(questionAnswers(questions, []), null);
  assert.equal(questionAnswers(questions, [{ selected: ["main"], custom: "" }, { selected: ["dev"], custom: "" }]), null);
  assert.equal(questionAnswers(questions, [{ selected: ["main"], custom: "" }, empty, { selected: [], custom: "Atlas" }]), null);
  const answers = questionAnswers(questions, [{ selected: ["main"], custom: "" }, { selected: ["dev"], custom: "lint" }, { selected: [], custom: "Atlas" }]);
  assert.deepEqual(answers, [["main"], ["dev", "lint"], ["Atlas"]]);
  assert.ok(answers);
  assert.deepEqual(questionsAnswer("que_1", answers), { kind: "question", requestId: "que_1", answers: [["main"], ["dev", "lint"], ["Atlas"]] });
  assert.equal(questionAnswers([], []), null);
});

const message = (id: string, text = id): RemoteSessionTranscriptMessage => ({ id, role: "assistant", createdAt: 1, text, truncated: false, toolCalls: [], error: null });
const read = (messages: RemoteSessionTranscriptMessage[], nextCursor: string | null, extra: Partial<RemoteSessionReadResult> = {}): RemoteSessionReadResult => ({
  title: "Task", status: "running", waitingFor: null, lastError: null, messageCount: messages.length, from: "end", messages, nextCursor, ...extra,
});

test("every open item is listed, and an older computer's single pending still shows", () => {
  const permission: RemoteSessionPending = { kind: "permission", requestId: "per_1", title: "Run pnpm test", detail: "" };
  const question: RemoteSessionPending = { kind: "question", requestId: "que_1", questions: [single] };
  assert.deepEqual(pendingItemsOf(read([], null, { pending: permission, pendingItems: [permission, question] })).map((item) => item.requestId), ["per_1", "que_1"]);
  assert.deepEqual(pendingItemsOf(read([], null, { pending: permission })).map((item) => item.requestId), ["per_1"]);
  assert.deepEqual(pendingItemsOf(read([], null, { pending: permission, pendingItems: [] })), []);
  assert.deepEqual(pendingItemsOf(read([], null)), []);
});

test("a message reads as its steps in order: words as text, tools as one line", () => {
  const steps = transcriptSteps({ ...message("m1", "Done."), parts: [
    { type: "reasoning", text: "Thinking it over" },
    { type: "tool", id: "t1", name: "bash", status: "completed", title: "List the release notes", input: "{}", output: "secret output", error: null, truncated: false },
    { type: "text", text: "Done." },
    { type: "text", text: "   " },
  ] });
  assert.deepEqual(steps, [
    { kind: "tool", key: "tool:t1", name: "List the release notes", status: "completed" },
    { kind: "text", key: "text:2", text: "Done." },
  ]);
  // An older computer sends words and tool calls apart: the work reads before the answer.
  assert.deepEqual(transcriptSteps({ ...message("m2", "All set."), toolCalls: [{ id: "t2", name: "read", status: "running", input: null, output: null, error: null, truncated: false }] }), [
    { kind: "tool", key: "tool:t2", name: "read", status: "running" },
    { kind: "text", key: "text", text: "All set." },
  ]);
  assert.equal(toolStatusLabel("completed"), "Done");
  assert.equal(toolStatusLabel("error"), "Failed");
  assert.equal(toolStatusLabel("queued"), "queued");
  assert.equal(toolStatusLabel(null), null);
});

test("a fresh read updates what is shown and keeps earlier pages; an earlier page goes in front", () => {
  const first = mergeLatestPage(undefined, read([message("m3"), message("m4")], "m3"));
  assert.equal(first.earlierCursor, "m3");
  const withEarlier = mergeEarlierPage(first, read([message("m1"), message("m2"), message("m3")], null));
  assert.deepEqual(withEarlier.messages.map((entry) => entry.id), ["m1", "m2", "m3", "m4"]);
  assert.equal(withEarlier.earlierCursor, null);
  assert.equal(withEarlier.read.status, "running");

  const refreshed = mergeLatestPage(withEarlier, read([message("m4", "edited"), message("m5")], "m4", { status: "idle" }));
  assert.deepEqual(refreshed.messages.map((entry) => entry.text), ["m1", "m2", "m3", "edited", "m5"]);
  assert.equal(refreshed.earlierCursor, null);
  assert.equal(refreshed.read.status, "idle");

  // Nothing in common with what is shown: the page stands on its own, with its own way back.
  const replaced = mergeLatestPage(refreshed, read([message("m40"), message("m41")], "m40"));
  assert.deepEqual(replaced.messages.map((entry) => entry.id), ["m40", "m41"]);
  assert.equal(replaced.earlierCursor, "m40");
});

test("a follow-up the computer accepted stays on screen until the next read brings it", () => {
  const shown = mergeLatestPage(undefined, read([message("m1"), message("m2")], null));
  const sent = appendSentMessage(shown, { id: "msg_new", text: "Also update the changelog", createdAt: 5 });
  assert.deepEqual(sent.messages.map((entry) => [entry.id, entry.role, entry.text]).at(-1), ["msg_new", "user", "Also update the changelog"]);
  assert.equal(appendSentMessage(sent, { id: "msg_new", text: "Also update the changelog", createdAt: 6 }), sent);
  // A read that has not caught up keeps it; one that has replaces it in place, with the reply after it.
  assert.deepEqual(mergeLatestPage(sent, read([message("m1"), message("m2")], null)).messages.map((entry) => entry.id), ["m1", "m2", "msg_new"]);
  const caughtUp = mergeLatestPage(sent, read([message("m2"), { ...message("msg_new", "Also update the changelog"), role: "user" }, message("m3")], "m2"));
  assert.deepEqual(caughtUp.messages.map((entry) => entry.id), ["m1", "m2", "msg_new", "m3"]);
});

const attachable = session({ key: "session:abc", origin: "local", reach: "attachable", commandId: null, state: "unknown" });
const identity = sessionIdentity(attachable);

test("a session keeps one identity while the list re-keys it from reported to connected", () => {
  assert.equal(identity, "cmp_1\nws_1\nses_1");
  assert.equal(sessionIdentity({ ...attachable, key: "command:cmd_9" }), identity);
  assert.notEqual(sessionIdentity({ ...attachable, sessionId: "ses_2" }), identity);
  assert.notEqual(sessionIdentity({ ...attachable, computerId: "cmp_2" }), identity);
  // A start that is still queued has no session yet: its key stands in.
  assert.equal(sessionIdentity({ key: "command:cmd_1", computerId: "cmp_1", workspaceId: null, sessionId: null }), "command:cmd_1");
});

test("pressing Connect, Den's answer and a refusal each move the attempt one step", () => {
  const requesting = attachRequested({}, identity);
  assert.deepEqual(requesting, { [identity]: { phase: "requesting" } });

  const attached = attachAnswered(requesting, identity, { state: "attached", commandId: "cmd_7" }, 500);
  assert.deepEqual(attached, { attempts: {}, open: "cmd_7" });
  const queued = attachAnswered(requesting, identity, { state: "queued", commandId: "cmd_7" }, 500);
  assert.deepEqual(queued, { attempts: { [identity]: { phase: "queued", since: 500 } }, open: null });

  assert.deepEqual(attachRefused(requesting, identity, "That computer is not connected. Start OpenWork there and try again."), {
    [identity]: { phase: "failed", message: "That computer is not connected. Start OpenWork there and try again." },
  });
  for (const empty of [null, undefined, "", "   "]) {
    assert.deepEqual(attachRefused(requesting, identity, empty), { [identity]: { phase: "failed", message: ATTACH_FAILED_MESSAGE } });
  }
  assert.deepEqual(attachDismissed(queued.attempts, identity), {});
  // Other sessions' attempts are left alone, and nothing is changed in place.
  const other = attachRequested(queued.attempts, "cmp_2\nws_1\nses_9");
  assert.deepEqual(Object.keys(other), [identity, "cmp_2\nws_1\nses_9"]);
  assert.deepEqual(requesting, { [identity]: { phase: "requesting" } });
});

test("the next list settles a queued Connect: reachable opens it, attachable again or gone is a failure", () => {
  const queued: Parameters<typeof settleAttachAttempts>[0] = { [identity]: { phase: "queued", since: 100 } };
  const connecting = session({ key: "command:cmd_9", origin: "local", reach: "connecting", commandId: "cmd_9", state: "starting" });
  const reachable = { ...connecting, reach: "reachable" as const, state: "idle" as const };

  // A list read before Den answered, and one that shows it still connecting, change nothing.
  assert.equal(settleAttachAttempts(queued, [attachable], 100, false).attempts, queued);
  const stillConnecting = settleAttachAttempts(queued, [connecting], 200, false);
  assert.equal(stillConnecting.attempts, queued);
  assert.equal(stillConnecting.open, null);

  assert.deepEqual(settleAttachAttempts(queued, [reachable], 200, false), { attempts: {}, open: "cmd_9" });
  // Reading another session by now: it connects, but nothing takes the member away from what they are reading.
  assert.deepEqual(settleAttachAttempts(queued, [reachable], 200, true), { attempts: {}, open: null });

  const failed: ReturnType<typeof settleAttachAttempts> = { attempts: { [identity]: { phase: "failed", message: ATTACH_FAILED_MESSAGE } }, open: null };
  assert.deepEqual(settleAttachAttempts(queued, [attachable], 200, false), failed);
  assert.deepEqual(settleAttachAttempts(queued, [], 200, false), failed);
  assert.deepEqual(settleAttachAttempts(queued, [session({ key: "other", sessionId: "ses_other" })], 200, false), failed);

  // Settled attempts stay as they are: a failure is not retried or reopened by later lists.
  const again = settleAttachAttempts(failed.attempts, [reachable], 300, false);
  assert.equal(again.attempts, failed.attempts);
  assert.equal(again.open, null);
  const requesting = attachRequested({}, identity);
  assert.equal(settleAttachAttempts(requesting, [reachable], 300, false).attempts, requesting);
});

test("several Connects settle together, and only the first to connect is opened", () => {
  const second = session({ key: "session:def", origin: "local", reach: "attachable", commandId: null, sessionId: "ses_2" });
  const third = session({ key: "session:ghi", origin: "local", reach: "attachable", commandId: null, sessionId: "ses_3" });
  const queued = {
    [identity]: { phase: "queued", since: 100 },
    [sessionIdentity(second)]: { phase: "queued", since: 100 },
    [sessionIdentity(third)]: { phase: "queued", since: 100 },
  } as const;
  const step = settleAttachAttempts(queued, [
    { ...attachable, key: "command:cmd_1", reach: "reachable", commandId: "cmd_1" },
    { ...second, key: "command:cmd_2", reach: "reachable", commandId: "cmd_2" },
    third,
  ], 200, false);
  assert.equal(step.open, "cmd_1");
  assert.deepEqual(step.attempts, { [sessionIdentity(third)]: { phase: "failed", message: ATTACH_FAILED_MESSAGE } });
});

test("a failed Connect whose session left the list is reported by the page, since no row can", () => {
  const failed = attachRefused({}, identity, null);
  assert.equal(lostAttachFailure(failed, [attachable]), null);
  assert.deepEqual(lostAttachFailure(failed, []), { identity, message: ATTACH_FAILED_MESSAGE });
  assert.equal(lostAttachFailure(attachRequested({}, identity), []), null);
  assert.equal(lostAttachFailure({}, []), null);
});

test("a state is one word with a dot whose colour marks only what needs attention", async () => {
  const { sessionStateDot, sessionStateLine } = await import("./sessions-model");
  assert.deepEqual(sessionStateDot("waiting"), { label: "Needs you", tone: "warning" });
  assert.deepEqual(sessionStateDot("running"), { label: "Working", tone: "success" });
  assert.deepEqual(sessionStateDot("idle"), { label: "Idle", tone: "neutral" });
  assert.deepEqual(sessionStateDot("starting"), { label: "Starting", tone: "neutral" });
  assert.deepEqual(sessionStateDot("error"), { label: "Error", tone: "danger" });
  assert.equal(sessionStateDot("unknown"), null);
  // Under an open session's title the same state is said to the person reading it.
  assert.deepEqual(sessionStateLine("waiting"), { label: "Waiting for you", tone: "warning" });
  assert.deepEqual(sessionStateLine("running"), { label: "Working", tone: "success" });
  assert.deepEqual(sessionStateLine("idle"), { label: "Idle", tone: "neutral" });
  assert.equal(sessionStateLine("unknown"), null);
});
