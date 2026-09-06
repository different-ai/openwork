import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCollaboration, nativeMessageId } from "./collaboration.mjs";
import { createGroupExecution, repairGroupSelection } from "./group-execution.mjs";
import {
  INTERRUPTED_TURN_MESSAGE,
  MAX_TURNS,
  appendGroupEvent,
  archiveGroup,
  beginGroupTurn,
  createGroup,
  deriveTurnStatus,
  getGroup,
  listGroups,
  listNames,
  normalizeParticipantSlugs,
  parseTimeline,
  readGroupTimeline,
  reconcileInterruptedGroupTurns,
  updateGroup,
  updateGroupTurn,
} from "./groups.mjs";

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), "coworker-groups-"));
  try {
    await run(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

test("a group needs two distinct valid coworkers", () => {
  const timestamp = 1_700_000_000_000;
  const first = nativeMessageId(timestamp);
  const second = nativeMessageId(timestamp);
  assert.equal(first.slice(4, 16), ((BigInt(timestamp) * 0x1000n + 1n) & 0xffffffffffffn).toString(16).padStart(12, "0"));
  assert.match(first, /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/);
  assert.ok(first < second);
  assert.deepEqual(normalizeParticipantSlugs(["scout", "nova", "scout"]), ["scout", "nova"]);
  assert.throws(() => normalizeParticipantSlugs(["scout"]), /at least two/);
  assert.throws(() => normalizeParticipantSlugs(["scout", "../etc"]), /Invalid coworker slug/);
});

test("groups are created, listed newest first, updated, and archived rather than deleted", async () => {
  await withHome(async (home) => {
    const first = await createGroup(home, { name: "  Research  desk ", participantSlugs: ["scout", "nova"] }, { now: 1_000 });
    const second = await createGroup(home, { name: "", participantSlugs: ["editor", "ops"] }, { now: 2_000 });
    assert.match(first.id, /^grp_[a-z0-9]{20}$/);
    assert.equal(first.name, "Research desk");
    assert.equal(second.name, "Group chat");
    assert.deepEqual((await listGroups(home)).map((group) => group.id), [second.id, first.id]);

    const updated = await updateGroup(home, first.id, { name: "Desk", participantThreadIds: { scout: "ses_1" } }, { now: 3_000 });
    assert.equal(updated.name, "Desk");
    assert.deepEqual(updated.participantThreadIds, { scout: "ses_1" });
    const cleared = await updateGroup(home, first.id, { participantThreadIds: { scout: "" } }, { now: 3_500 });
    assert.deepEqual(cleared.participantThreadIds, {});
    assert.equal((await getGroup(home, first.id)).updatedAt, 3_500);

    const archived = await archiveGroup(home, second.id, { now: 4_000 });
    assert.equal(archived.archivedAt, 4_000);
    assert.equal((await listGroups(home)).find((group) => group.id === second.id)?.archivedAt, 4_000);
    await assert.rejects(getGroup(home, "grp_../escape"), /Invalid group id/);
  });
});

test("timeline events append in order, tolerate one truncated final line, and validate their shape", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "nova"] });
    assert.deepEqual(await readGroupTimeline(home, group.id), []);
    const [user, reply] = await Promise.all([
      appendGroupEvent(home, group.id, { kind: "user", text: "Hello both", clientMessageId: "msg-1" }, { now: 10 }),
      appendGroupEvent(home, group.id, { kind: "coworker", slug: "scout", text: "Hi", turnId: "turn-1", threadId: "ses_1" }, { now: 20 }),
    ]);
    assert.match(user.id, /^evt_/);
    assert.equal(reply.slug, "scout");
    const events = await readGroupTimeline(home, group.id);
    assert.deepEqual(events.map((event) => [event.kind, event.text, event.at]), [["user", "Hello both", 10], ["coworker", "Hi", 20]]);

    const file = path.join(home, ".groups", group.id, "timeline.jsonl");
    await writeFile(file, `${await readFile(file, "utf8")}{"id":"evt_x","kind":"status","te`, "utf8");
    assert.equal((await readGroupTimeline(home, group.id)).length, 2);
    assert.throws(() => parseTimeline('{"id":"evt_a","kind":"user","text":"a"}\nnot json\n{"id":"evt_b","kind":"user","text":"b"}\n'));

    await assert.rejects(appendGroupEvent(home, group.id, { kind: "coworker", text: "no slug" }), /names its coworker/);
    await assert.rejects(appendGroupEvent(home, group.id, { kind: "bogus", text: "x" }), /Unknown timeline event kind/);
    assert.equal((await readGroupTimeline(home, group.id, { limit: 1 })).length, 1);
  });
});

test("a turn's status follows its speakers", () => {
  assert.equal(deriveTurnStatus([]), "routing");
  assert.equal(deriveTurnStatus([{ status: "queued" }, { status: "succeeded" }]), "running");
  assert.equal(deriveTurnStatus([{ status: "succeeded" }, { status: "passed" }]), "succeeded");
  assert.equal(deriveTurnStatus([{ status: "succeeded" }, { status: "failed" }]), "partial");
  assert.equal(deriveTurnStatus([{ status: "succeeded" }, { status: "stopped" }]), "partial");
  assert.equal(deriveTurnStatus([{ status: "failed" }, { status: "failed" }]), "failed");
  assert.equal(deriveTurnStatus([{ status: "failed" }, { status: "stopped" }]), "stopped");
  assert.equal(listNames(["Scout"]), "Scout");
  assert.equal(listNames(["Scout", "Editor", "Ops"]), "Scout, Editor and Ops");
});

test("a turn is recorded once per client message, with its user line, and is updated through the store", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "editor"] }, { now: 1 });
    const begun = await beginGroupTurn(home, group.id, { clientMessageId: "m1", prompt: "  Plan the launch note  " }, { now: 10 });
    assert.equal(begun.created, true);
    assert.match(begun.turn.id, /^turn_[a-z0-9]{20}$/);
    assert.equal(begun.turn.status, "routing");
    assert.equal(begun.turn.prompt, "Plan the launch note");
    assert.equal(begun.userEvent?.kind, "user");
    assert.equal(begun.userEvent?.turnId, begun.turn.id);

    // A double Send never opens a second turn or a second user line.
    const again = await beginGroupTurn(home, group.id, { clientMessageId: "m1", prompt: "Plan the launch note" }, { now: 11 });
    assert.equal(again.created, false);
    assert.equal(again.turn.id, begun.turn.id);
    assert.equal(again.userEvent, null);
    assert.equal((await readGroupTimeline(home, group.id)).length, 1);
    assert.equal((await getGroup(home, group.id)).turns.length, 1);

    const routed = await updateGroupTurn(home, group.id, begun.turn.id, {
      routedBy: "mentions",
      speakers: [{ slug: "scout", brief: "Sources first." }, { slug: "editor" }],
    }, { now: 20 });
    assert.equal(routed.status, "running");
    assert.equal(routed.routedBy, "mentions");
    assert.deepEqual(routed.speakers.map((speaker) => [speaker.slug, speaker.order, speaker.status, speaker.part, speaker.brief]), [
      ["scout", 0, "queued", "reply", "Sources first."],
      ["editor", 1, "queued", "reply", ""],
    ]);

    const running = await updateGroupTurn(home, group.id, begun.turn.id, { speaker: { slug: "scout", status: "running", startedAt: 21, threadId: "ses_1" } }, { now: 21 });
    assert.equal(running.speakers[0].status, "running");
    assert.equal(running.speakers[0].threadId, "ses_1");
    await updateGroupTurn(home, group.id, begun.turn.id, { speaker: { slug: "scout", status: "succeeded", endedAt: 22 } }, { now: 22 });
    const failed = await updateGroupTurn(home, group.id, begun.turn.id, { speaker: { slug: "editor", status: "failed", error: "model unavailable", endedAt: 23 } }, { now: 23 });
    assert.equal(failed.status, "partial");
    assert.equal(failed.speakers[1].error, "model unavailable");

    // The same coworker can reply and later wrap up, but not reply twice.
    await assert.rejects(updateGroupTurn(home, group.id, begun.turn.id, { speakers: [{ slug: "scout" }, { slug: "scout" }] }), /Duplicate speaker/);
    const wrapped = await updateGroupTurn(home, group.id, begun.turn.id, { speakers: [{ slug: "scout" }, { slug: "editor" }, { slug: "scout", part: "wrap-up" }] });
    assert.equal(wrapped.speakers[2].part, "wrap-up");
    await assert.rejects(updateGroupTurn(home, group.id, begun.turn.id, { speaker: { slug: "ops", status: "running" } }), /not part of this turn/);
    await assert.rejects(updateGroupTurn(home, group.id, "turn_missing", { status: "failed" }), /no longer recorded/);
    await assert.rejects(beginGroupTurn(home, group.id, { clientMessageId: "", prompt: "x" }), /client id/);
    await assert.rejects(beginGroupTurn(home, group.id, { clientMessageId: "m2", prompt: "   " }), /message/);

    // Concurrent updates to two speakers both land.
    const second = await beginGroupTurn(home, group.id, { clientMessageId: "m2", prompt: "Again" }, { now: 30 });
    await updateGroupTurn(home, group.id, second.turn.id, { speakers: [{ slug: "scout" }, { slug: "editor" }] });
    await Promise.all([
      updateGroupTurn(home, group.id, second.turn.id, { speaker: { slug: "scout", status: "succeeded" } }),
      updateGroupTurn(home, group.id, second.turn.id, { speaker: { slug: "editor", status: "passed" } }),
    ]);
    const stored = (await getGroup(home, group.id)).turns.find((turn) => turn.id === second.turn.id);
    assert.deepEqual(stored.speakers.map((speaker) => speaker.status), ["succeeded", "passed"]);
    assert.equal(stored.status, "succeeded");
  });
});

test("only the last turns are kept while every timeline line stays", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "editor"] });
    for (let index = 0; index < MAX_TURNS + 3; index += 1) {
      await beginGroupTurn(home, group.id, { clientMessageId: `m${index}`, prompt: `Message ${index}` }, { now: index });
    }
    const stored = await getGroup(home, group.id);
    assert.equal(stored.turns.length, MAX_TURNS);
    assert.equal(stored.turns[0].clientMessageId, "m3");
    assert.equal((await readGroupTimeline(home, group.id)).length, MAX_TURNS + 3);
  });
});

test("turns cut off by a quit become partial with one quiet line, and finished replies are untouched", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "editor", "ops"] });
    const done = await beginGroupTurn(home, group.id, { clientMessageId: "m0", prompt: "Earlier" }, { now: 1 });
    await updateGroupTurn(home, group.id, done.turn.id, { speakers: [{ slug: "scout", status: "succeeded" }] });
    const live = await beginGroupTurn(home, group.id, { clientMessageId: "m1", prompt: "Plan" }, { now: 2 });
    await updateGroupTurn(home, group.id, live.turn.id, { speakers: [{ slug: "scout", status: "succeeded" }, { slug: "editor", status: "running" }, { slug: "ops" }] });
    await appendGroupEvent(home, group.id, { kind: "coworker", slug: "scout", text: "Sources ready.", turnId: live.turn.id });
    const routing = await beginGroupTurn(home, group.id, { clientMessageId: "m2", prompt: "And this" }, { now: 3 });
    const active = await beginGroupTurn(home, group.id, { clientMessageId: "m3", prompt: "Still running elsewhere" }, { now: 4 });

    const names = { scout: "Scout", editor: "Editor", ops: "Ops" };
    const recovered = await reconcileInterruptedGroupTurns(home, { activeTurnIds: new Set([active.turn.id]), nameFor: (slug) => names[slug], now: 100 });
    assert.deepEqual(recovered.map((entry) => entry.turnId), [live.turn.id, routing.turn.id]);

    const stored = await getGroup(home, group.id);
    const turns = Object.fromEntries(stored.turns.map((turn) => [turn.id, turn]));
    assert.equal(turns[done.turn.id].status, "succeeded");
    assert.equal(turns[live.turn.id].status, "partial");
    assert.deepEqual(turns[live.turn.id].speakers.map((speaker) => [speaker.status, speaker.error]), [
      ["succeeded", ""],
      ["stopped", INTERRUPTED_TURN_MESSAGE],
      ["stopped", INTERRUPTED_TURN_MESSAGE],
    ]);
    assert.equal(turns[routing.turn.id].status, "partial");
    assert.equal(turns[active.turn.id].status, "routing", "a turn this process is still running is left alone");

    const statuses = (await readGroupTimeline(home, group.id)).filter((event) => event.kind === "status");
    assert.deepEqual(statuses.map((event) => [event.turnId, event.status, event.text]), [
      [live.turn.id, "interrupted", "Stopped when the app closed before Editor and Ops replied."],
      [routing.turn.id, "interrupted", "Stopped when the app closed before anyone replied."],
    ]);
    // Running it again changes nothing: the interrupted turns are already settled.
    assert.deepEqual(await reconcileInterruptedGroupTurns(home, { activeTurnIds: new Set([active.turn.id]), now: 101 }), []);
    assert.equal((await readGroupTimeline(home, group.id)).filter((event) => event.kind === "status").length, 2);
  });
});

test("an action line names its coworker and what it links to", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "editor"] });
    const action = await appendGroupEvent(home, group.id, { kind: "action", slug: "editor", action: "assignment", title: "Draft the launch note", threadId: "ses_9", text: "Assignment for Editor · Draft the launch note" });
    assert.equal(action.action, "assignment");
    assert.equal(action.title, "Draft the launch note");
    await assert.rejects(appendGroupEvent(home, group.id, { kind: "action", text: "no owner" }), /names its coworker/);
    // Older readers skip a kind they do not know instead of failing the whole timeline.
    assert.equal(parseTimeline('{"id":"evt_a","kind":"user","text":"a"}\n{"id":"evt_b","kind":"later-kind","text":"b"}\n').length, 1);
  });
});

function nativeFixture(onSend = async () => {}) {
  const histories = new Map();
  const requests = [];
  const aborted = [];
  const held = new Set();
  let sequence = 0;
  const snapshot = (threadId) => ({ threadId, title: threadId, status: { type: held.has(threadId) ? "busy" : "idle" }, messages: histories.get(threadId) ?? [], todos: [] });
  return { requests, aborted, histories, held, clientFor: async (slug) => ({
    createThread: async () => ({ id: `ses_${++sequence}` }),
    getThreadSnapshot: async (threadId) => snapshot(threadId),
    sendTurn: async (threadId, input) => {
      const messages = histories.get(threadId) ?? [];
      const present = messages.some((message) => message.id === input.messageId);
      if (!present) {
        requests.push({ slug, threadId, ...input });
        const reply = { id: `assistant_${++sequence}`, role: "assistant", parentId: input.messageId, completedAt: null, error: null, parts: [{ type: "tool", callId: `call_${sequence}` }] };
        messages.push({ id: input.messageId, role: "user", parentId: null, parts: [{ type: "text", text: input.prompt }] }, reply);
        histories.set(threadId, messages);
        await onSend({ slug, threadId, input, reply });
        reply.completedAt = Date.now();
        reply.parts.push({ type: "text", text: slug === "editor" ? "CHECKED PUBLIC FACT" : "Original task followed up." });
      }
      return { threadId, messageId: input.messageId, messageCountBefore: 0, acceptedAt: Date.now(), alreadyPresent: present };
    },
    waitForThread: async (threadId, input) => {
      if (held.has(threadId)) await new Promise((resolve) => setTimeout(resolve, 5));
      return { outcome: input.signal?.aborted ? "aborted" : held.has(threadId) ? "timeout" : "settled", snapshot: snapshot(threadId), terminalError: null };
    },
    abortThread: async (threadId) => { aborted.push(threadId); held.delete(threadId); return { accepted: true }; },
  }) };
}

async function eventually(check) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail("The collaboration did not settle within the module check's deadline.");
}

test("a focused consultation and a Worker resume the immutable private origin exactly once", async () => {
  await withHome(async (home) => {
    let service;
    let groups;
    let workerId;
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (slug !== "scout" || input.prompt !== "PRIVATE ORIGIN ONLY") return;
      const trusted = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
      await assert.rejects(service.context(slug, { sessionID: threadId, messageID: reply.id, callID: "made-up-call" }), /admitted parent/);
      await assert.rejects(service.request(trusted, "consultation", { to: "scout", question: "self" }), /cannot ask itself/);
      const consultation = { to: "editor", question: "Check the public fact", context: "SHARED FACT", continuation: { objective: "PRIVATE ORIGIN ONLY", completedActions: ["Read the brief"], resumeInstructions: "Use the two results." } };
      const first = await service.request(trusted, "consultation", consultation);
      const duplicate = await service.request(trusted, "consultation", consultation);
      assert.equal(first.structured.collaboration.id, duplicate.structured.collaboration.id);
      const worker = await service.request({ ...trusted, callId: "second-native-call" }, "worker", { name: "Bounded check", goal: "Check once", continuation: consultation.continuation });
      workerId = worker.structured.worker.id;
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      consult: (task) => groups.consultation(task),
      spawn: async (slug, input) => {
        await service.completeWorker({ slug, id: input.id, status: "finished" }, [{ kind: "finding", text: "WORKER RESULT" }]);
        return { id: input.id, status: "finished" };
      }, cancelWorker: async () => {},
      publish: (task) => task.groupId ? appendGroupEvent(home, task.groupId, { id: `answer_${task.id}`, kind: "coworker", slug: task.to, text: task.result }) : undefined,
    });
    groups = createGroupExecution({ directory: home, collaboration: service, coworkerFor: async (slug) => ({ slug, name: slug, role: "", mission: "" }), clientFor: fixture.clientFor });
    try {
      const owner = { slug: "scout", threadId: "ses_private", conversationId: "ses_private", kind: "private" };
      await service.registerOwner({ ...owner, threadId: "ses_other", conversationId: "ses_other" });
      await service.submit({ owner, messageId: "msg_request", prompt: "PRIVATE ORIGIN ONLY", track: true });
      await eventually(async () => (await service.receipts({ slug: "scout", threadId: "ses_private" }))[0]?.state === "succeeded");
      await service.completeWorker({ slug: "scout", id: workerId, status: "finished" }, [{ kind: "finding", text: "DUPLICATE" }]);
      const replies = fixture.requests.filter((request) => request.prompt.startsWith("Continue the original task"));
      assert.equal(replies.length, 1);
      assert.equal(replies[0].threadId, "ses_private");
      assert.match(replies[0].prompt, /CHECKED PUBLIC FACT/);
      assert.match(replies[0].prompt, /WORKER RESULT/);
      assert.doesNotMatch(replies[0].prompt, /DUPLICATE/);
      assert.equal(fixture.requests.some((request) => request.threadId === "ses_other"), false);
      const question = fixture.requests.find((request) => request.slug === "editor");
      assert.match(question.prompt, /SHARED FACT/);
      assert.doesNotMatch(question.prompt, /PRIVATE ORIGIN ONLY|Read the brief/);
      const group = (await listGroups(home))[0];
      const events = await readGroupTimeline(home, group.id);
      assert.equal(events.filter((event) => event.slug === "scout").length, 1);
      assert.equal(events.filter((event) => event.slug === "editor").length, 1);
      assert.ok((await service.excludedThreads("editor")).includes(question.threadId));
      await assert.rejects(service.registerOwner({ slug: "editor", threadId: question.threadId, conversationId: question.threadId, kind: "private" }), /another conversation/);
    } finally { groups.stop(); await service.stop(); }
  });
});

test("completion before yield, restart delivery, and cancellation do not duplicate or resurrect a continuation", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5, consult: async () => { throw new Error("Not used"); }, spawn: async () => { throw new Error("Not used"); }, cancelWorker: async () => {} };
    let service = createCollaboration(options);
    const owner = { slug: "scout", threadId: "ses_origin", conversationId: "ses_origin", kind: "private" };
    const root = await service.submit({ owner, messageId: "msg_root", prompt: "Finish the original work" });
    const result = await service.request({ entry: root, callId: "early" }, "worker", { name: "Early result", goal: "Check", continuation: { objective: "Original work", resumeInstructions: "Use the result" } });
    await service.completeWorker({ id: result.structured.worker.id, slug: "scout", status: "finished" }, [{ kind: "finding", text: "KEPT RESULT" }]);
    assert.equal((await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].state, "running");
    await service.stop();
    service = createCollaboration(options);
    try {
      await service.start();
      await eventually(async () => (await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].state === "succeeded");
      assert.equal(fixture.requests.filter((request) => request.prompt.startsWith("Continue the original task")).length, 1);
      const next = await service.submit({ owner: { ...owner, threadId: "ses_cancel", conversationId: "ses_cancel" }, messageId: "msg_cancel", prompt: "Cancelled work" });
      const child = await service.request({ entry: next, callId: "cancel-child" }, "worker", { name: "Cancelled child", goal: "Check" });
      await service.cancel(next.id);
      await service.completeWorker({ id: child.structured.worker.id, slug: "scout", status: "finished" }, [{ kind: "finding", text: "LATE RESULT" }]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await service.receipts({ slug: "scout", threadId: "ses_cancel" }))[0].state, "cancelled");
      assert.equal(fixture.requests.some((request) => request.threadId === "ses_cancel" && request.prompt.includes("LATE RESULT")), false);
    } finally { await service.stop(); }
  });
});

test("the backend group runner cancels every parallel native speaker", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ slug, threadId, reply }) => {
      if (slug === ".coordinator") reply.parts.push({ type: "text", text: JSON.stringify({ speakers: [{ slug: "scout" }, { slug: "editor" }], mode: "parallel" }) });
      else fixture.held.add(threadId);
    });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, consult: async () => {}, spawn: async () => {}, cancelWorker: async () => {} });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor,
      coworkerFor: async (slug) => ({ slug, name: slug, role: "", mission: "", model: "test/model" }),
      coordinator: async () => ({ workspaceId: "coordinator" }),
      catalogFor: async () => ({ models: [{ id: "test/model", providerId: "test", modelId: "model", variants: [], source: "local", tier: "key", toolCall: true, status: "active", label: "Test", releaseDate: "" }] }),
    });
    try {
      const group = await createGroup(home, { name: "Pair", participantSlugs: ["scout", "editor"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "parallel", text: "@everyone Check your part independently." });
      await eventually(() => fixture.requests.filter((request) => request.slug !== ".coordinator").length === 2);
      const threads = fixture.requests.filter((request) => request.slug !== ".coordinator").map((request) => request.threadId);
      await groups.cancel(group.id);
      await eventually(async () => !(await groups.status(group.id)).active);
      assert.ok(threads.every((id) => fixture.aborted.includes(id)));
      assert.deepEqual((await getGroup(home, group.id)).turns[0].speakers.map((speaker) => speaker.status), ["stopped", "stopped"]);
    } finally { groups.stop(); await service.stop(); }
  });
});

test("backend Next drains without a view and results queue behind a foreground reply", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, consult: async () => {}, spawn: async (_slug, input) => ({ id: input.id, status: "running" }), cancelWorker: async () => {} });
    const owner = { slug: "scout", threadId: "ses_queue", conversationId: "ses_queue", kind: "private" };
    try {
      const root = await service.submit({ owner, messageId: "msg_queue", prompt: "Original", track: true });
      const child = await service.request({ entry: root, callId: "child" }, "worker", { name: "Check", goal: "Check once" });
      const before = await service.threadState(owner.slug, owner.threadId);
      await service.updateThread(owner.slug, owner.threadId, before, { ...before, next: [{ id: "next_a", text: "Foreground next", queuedAt: Date.now() }] });
      await service.completeWorker({ slug: "scout", id: child.structured.worker.id, status: "finished" }, [{ kind: "finding", text: "READY" }]);
      await eventually(async () => (await service.receipts({ slug: owner.slug, threadId: owner.threadId }))[0]?.state === "succeeded");
      assert.equal(fixture.requests[1].prompt, "Foreground next");
      assert.match(fixture.requests[2].prompt, /^Continue the original task/);
      assert.equal((await service.threadState(owner.slug, owner.threadId)).next.length, 0);
    } finally { await service.stop(); }
  });
});

test("explicit follow-up keeps the prior failure and native history", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ input, reply }) => { if (input.prompt === "Original failure") reply.error = { message: "A tool step failed." }; });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5 });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_retry", conversationId: "ses_retry", kind: "private" }, messageId: "msg_retry", prompt: "Original failure", track: true });
      await eventually(async () => (await service.read((state) => state.tasks[root.taskId])).state === "failed" && fixture.aborted.includes("ses_retry"));
      await service.retry(root.taskId);
      await eventually(async () => (await service.read((state) => state.tasks[root.taskId])).state === "succeeded");
      const original = await service.read((state) => state.executions[root.id]);
      assert.equal(original.state, "failed");
      assert.equal(original.error, "A tool step failed.");
      assert.equal(fixture.requests.length, 2);
      assert.notEqual(fixture.requests[1].messageId, root.messageId);
      assert.match(fixture.requests[1].prompt, /^Continue the original task/);
      assert.equal(fixture.histories.get("ses_retry").filter((message) => message.role === "user").length, 2);
    } finally { await service.stop(); }
  });
});

test("a nested consultation delivers the final child continuation to its parent once", async () => {
  await withHome(async (home) => {
    let service;
    const published = [];
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (input.prompt === "Private task" || input.prompt === "Focused B question") {
        const trusted = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
        await service.request(trusted, "consultation", { to: slug === "scout" ? "editor" : "ops", question: slug === "scout" ? "Focused B question" : "Focused C question", continuation: { objective: input.prompt, resumeInstructions: "Synthesize the requested answer." } });
        reply.parts.push({ type: "text", text: "ACKNOWLEDGEMENT ONLY" });
      } else if (slug === "editor") reply.parts.push({ type: "text", text: "FINAL B SYNTHESIS" });
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      consult: async (task) => ({ owner: { slug: task.to, threadId: `ses_${task.to}`, conversationId: "grp_nested", groupId: "grp_nested", kind: "consultation" }, prompt: task.input.question }),
      publish: async (task) => { published.push({ id: task.id, result: task.result }); },
    });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_private", conversationId: "ses_private", kind: "private" }, messageId: "msg_nested", prompt: "Private task" });
      await eventually(async () => (await service.read((state) => state.tasks[root.taskId])).state === "succeeded");
      const final = fixture.requests.filter((request) => request.threadId === "ses_private" && request.prompt.startsWith("Continue the original task"));
      assert.equal(final.length, 1);
      assert.match(final[0].prompt, /FINAL B SYNTHESIS/);
      assert.doesNotMatch(final[0].prompt, /ACKNOWLEDGEMENT ONLY/);
      assert.equal(fixture.requests.filter((request) => request.slug === "editor" && request.prompt.startsWith("Continue the original task")).length, 1);
      assert.equal(new Set(published.map((entry) => entry.id)).size, 2);
      assert.equal(published.length, 2);
    } finally { await service.stop(); }
  });
});

test("cancellation fences a stale pump snapshot and cannot be retried into running", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    let release;
    const preparing = new Promise((resolve) => { release = resolve; });
    const called = [];
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, setupTimeoutMs: 500,
      consult: async (task) => { called.push(task.to); await preparing; return { owner: { slug: task.to, threadId: `ses_${task.to}`, conversationId: "grp_cancel", groupId: "grp_cancel", kind: "consultation" }, prompt: "Must not execute" }; },
    });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_cancel", conversationId: "ses_cancel", kind: "private" }, messageId: "msg_cancel_snapshot", prompt: "Request two answers" });
      await service.request({ entry: root, callId: "first" }, "consultation", { to: "editor", question: "First" });
      await service.request({ entry: root, callId: "second" }, "consultation", { to: "ops", question: "Second" });
      await eventually(() => called.length === 1);
      await service.cancel(root.taskId);
      release();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(called, ["editor"]);
      assert.equal(fixture.requests.some((request) => request.slug !== "scout"), false);
      assert.equal((await service.read((state) => state.tasks[root.taskId])).state, "cancelled");
      await assert.rejects(service.retry(root.taskId), /new request/);
      await assert.rejects(service.submit({ ...root, retry: true }), /cancelled/);
    } finally { release(); await service.stop(); }
  });
});

test("global admission is finite, queue time is not execution time, and acceptance is bounded", async () => {
  await withHome(async (home) => {
    let clock = 1000;
    const fixture = nativeFixture(async ({ threadId }) => { if (threadId === "ses_first") fixture.held.add(threadId); });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, maxActiveExecutions: 1, stepTimeoutMs: 5000, now: () => clock });
    const owner = (id) => ({ slug: "scout", threadId: id, conversationId: id, kind: "private" });
    try {
      await service.submit({ owner: owner("ses_first"), messageId: "msg_first", prompt: "Hold this reply" });
      await eventually(() => fixture.held.size === 1);
      const queued = await service.submit({ owner: owner("ses_second"), messageId: "msg_second", prompt: "Wait for a slot" });
      clock += 60_000;
      await assert.rejects(service.acceptance(queued.id, { timeoutMs: 20 }), /recorded|kept/);
      assert.equal(fixture.requests.length, 1);
      const waiting = await service.read((state) => state.executions[queued.id]);
      assert.equal(waiting.deadline, null);
      assert.equal(waiting.state, "queued");
      fixture.held.clear();
      await eventually(async () => (await service.read((state) => state.executions[queued.id])).state === "succeeded");
      assert.equal((await service.read((state) => state.executions[queued.id])).deadline, clock + 5000);
      assert.equal(fixture.requests.length, 2);
      assert.throws(() => createCollaboration({ directory: home, maxActiveExecutions: Infinity }), /between 1 and 16/);
    } finally { await service.stop(); }
  });
});

test("a hung consultation setup fails readably and late preparation cannot execute", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    let release;
    const setup = new Promise((resolve) => { release = resolve; });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, setupTimeoutMs: 20, consult: () => setup });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_setup", conversationId: "ses_setup", kind: "private" }, messageId: "msg_setup", prompt: "Need a teammate" });
      const requested = await service.request({ entry: root, callId: "setup" }, "consultation", { to: "editor", question: "A focused question" });
      await eventually(async () => (await service.read((state) => state.tasks[requested.structured.collaboration.id])).state === "failed");
      release({ owner: { slug: "editor", threadId: "ses_late", conversationId: "grp_late", kind: "consultation" }, prompt: "Late preparation" });
      await eventually(async () => (await service.read((state) => state.tasks[root.taskId])).state === "succeeded");
      assert.match((await service.read((state) => state.tasks[requested.structured.collaboration.id])).error, /prepared in time/);
      assert.equal(fixture.requests.some((request) => request.threadId === "ses_late"), false);
      assert.match(fixture.requests.at(-1).prompt, /prepared in time/);
    } finally { release(); await service.stop(); }
  });
});

test("projection failure stops after three attempts and retry restores delivery without replay", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    let attempts = 0;
    let available = false;
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      consult: async () => ({ owner: { slug: "editor", threadId: "ses_projection", conversationId: "grp_projection", groupId: "grp_projection", kind: "consultation" }, prompt: "Focused question" }),
      publish: async () => { attempts++; if (!available) throw new Error("Local projection failed"); },
    });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_origin", conversationId: "ses_origin", kind: "private" }, messageId: "msg_projection", prompt: "Original task" });
      await service.request({ entry: root, callId: "projection" }, "consultation", { to: "editor", question: "Focused question" });
      await eventually(async () => (await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].state === "failed");
      assert.equal(attempts, 3);
      assert.match((await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].error, /three attempts|could not be shown/);
      assert.equal(fixture.requests.filter((request) => request.prompt.startsWith("Continue the original task")).length, 0);
      available = true;
      await service.retry(root.taskId);
      await eventually(async () => (await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].state === "succeeded");
      assert.equal(fixture.requests.filter((request) => request.threadId === "ses_projection").length, 1);
      assert.equal(fixture.requests.filter((request) => request.prompt.startsWith("Continue the original task")).length, 1);
    } finally { await service.stop(); }
  });
});

test("missing group defaults migrate and repeated store failures become a readable service fault", async () => {
  await withHome(async (home) => {
    const directory = path.join(home, ".collaboration");
    await mkdir(directory);
    const old = { version: 1, executions: {}, tasks: {}, owners: {}, threads: {} };
    await writeFile(path.join(directory, "state.json"), JSON.stringify(old));
    const fixture = nativeFixture();
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 10 });
    try {
      assert.deepEqual(await service.read((state) => state.groups), {});
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_disk", conversationId: "ses_disk", kind: "private" }, messageId: "msg_disk", prompt: "Keep this work" });
      await mkdir(path.join(directory, "state.json.tmp"));
      await assert.rejects(service.acceptance(root.id, { timeoutMs: 1000 }), /three local service failures/);
      assert.equal(fixture.requests.length, 0, "failed admission persistence never starts inference");
      await assert.rejects(service.receipts({ slug: "scout", threadId: "ses_disk" }), /Existing work has been kept/);
    } finally { await service.stop(); }
  });
});

test("legacy group selections clear only the selection pointer", async () => {
  const groups = [{ participantThreadIds: { scout: "ses_group" } }];
  const coworker = { slug: "scout", conversationThreadId: "ses_group", mission: "Keep my work", model: "test/model" };
  const changes = [];
  const update = async (slug, patch) => { changes.push({ slug, patch }); return { ...coworker, ...patch }; };
  assert.deepEqual(await repairGroupSelection(coworker, groups, update), { ...coworker, conversationThreadId: "" });
  assert.deepEqual(changes, [{ slug: "scout", patch: { conversationThreadId: "" } }]);
  const privateSelection = { ...coworker, conversationThreadId: "ses_private" };
  assert.equal(await repairGroupSelection(privateSelection, groups, update), privateSelection);
  assert.equal(changes.length, 1);
});

test("group retry sends a new follow-up and retains the accepted tool-bearing attempt", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ input, reply }) => {
      if (!input.prompt.startsWith("Continue the earlier group request")) reply.error = { message: "Interrupted after a tool action" };
    });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5 });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, pollMs: 5, coworkerFor: async (slug) => ({ slug, name: slug, role: "", mission: "" }) });
    try {
      const group = await createGroup(home, { name: "Pair", participantSlugs: ["scout", "editor"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "first-tool-attempt", text: "@scout Finish the bounded task" });
      await eventually(async () => !(await groups.status(group.id)).active);
      const failed = (await getGroup(home, group.id)).turns[0];
      assert.equal(failed.status, "failed");
      const original = await service.read((state) => Object.values(state.executions)[0]);
      await groups.submit(group.id, { clientMessageId: "explicit-follow-up", text: failed.prompt, turnId: failed.id });
      await eventually(async () => !(await groups.status(group.id)).active);
      assert.equal((await getGroup(home, group.id)).turns[0].status, "succeeded");
      assert.equal(fixture.requests.length, 2);
      assert.match(fixture.requests[1].prompt, /^Continue the earlier group request/);
      assert.match(fixture.requests[1].prompt, /not permission to repeat completed tool actions/);
      assert.equal(fixture.requests[1].threadId, fixture.requests[0].threadId);
      assert.notEqual(fixture.requests[1].messageId, fixture.requests[0].messageId);
      assert.equal((await service.read((state) => state.executions[original.id])).state, "failed");
      assert.equal(fixture.histories.get(original.owner.threadId).filter((message) => message.role === "user").length, 2);
      assert.equal(fixture.histories.get(original.owner.threadId).filter((message) => message.parentId === original.messageId && message.parts.some((part) => part.type === "tool")).length, 1);
    } finally { groups.stop(); await service.stop(); }
  });
});

test("general group messages stay within the existing speaker budget including extra parts", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ slug, reply }) => {
      if (slug === ".coordinator") reply.parts.push({ type: "text", text: JSON.stringify({ speakers: [{ slug: "scout" }, { slug: "editor" }, { slug: "ops" }], followUp: { slug: "scout", brief: "React" }, synthesizer: "editor" }) });
    });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5 });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, pollMs: 5,
      coworkerFor: async (slug) => ({ slug, name: slug, role: "", mission: "", model: "test/model" }),
      coordinator: async () => ({ workspaceId: "coordinator" }),
      catalogFor: async () => ({ models: [{ id: "test/model", providerId: "test", modelId: "model", variants: [], source: "local", tier: "key", toolCall: true, status: "active", label: "Test", releaseDate: "" }] }),
    });
    try {
      const group = await createGroup(home, { name: "Team", participantSlugs: ["scout", "editor", "ops"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "general-budget", text: "What should we consider?" });
      await eventually(async () => !(await groups.status(group.id)).active);
      assert.equal((await getGroup(home, group.id)).turns[0].speakers.length, 3);
      assert.equal(fixture.requests.filter((request) => request.slug !== ".coordinator").length, 3);
    } finally { groups.stop(); await service.stop(); }
  });
});

test("cancellation during native setup prevents admission after setup returns", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    let release;
    let preparing = false;
    const gate = new Promise((resolve) => { release = resolve; });
    const service = createCollaboration({ directory: home, pollMs: 5, setupTimeoutMs: 500,
      clientFor: async (slug) => { preparing = true; await gate; return fixture.clientFor(slug); },
    });
    try {
      const entry = await service.submit({ owner: { slug: "scout", threadId: "ses_cancel_setup", conversationId: "ses_cancel_setup", kind: "private" }, messageId: "msg_cancel_setup", prompt: "Do not start after cancellation" });
      await eventually(() => preparing);
      await service.cancel(entry.id);
      release();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(fixture.requests.length, 0);
      assert.equal((await service.read((state) => state.executions[entry.id])).state, "cancelled");
    } finally { release(); await service.stop(); }
  });
});
