import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCollaboration, nativeMessageId } from "./collaboration.mjs";
import { createGroupExecution, repairGroupSelection } from "./group-execution.mjs";
import { withInteractiveQuestionDefault } from "./collaboration-plugin.mjs";
import { createWorker, getWorker, nextWorkerState, parseWorkerReport, prepareWorkerTurn, queueWorkerSteer, updateWorker } from "./workers.mjs";
import { createCoworkerThreads } from "../src/lib/threads.ts";
import {
  INTERRUPTED_TURN_MESSAGE,
  MAX_TURNS,
  appendGroupEvent,
  archiveGroup,
  beginGroupTurn,
  createGroup,
  getGroup,
  listGroups,
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

test("native questions get a client default without overriding explicit tool rules", () => {
  assert.deepEqual(withInteractiveQuestionDefault({}), { permission: { question: "allow" } });
  assert.deepEqual(withInteractiveQuestionDefault({ permission: { bash: "ask" } }), { permission: { bash: "ask", question: "allow" } });
  for (const config of [{ permission: "deny" }, { permission: { "*": "ask" } }, { permission: { question: "deny" } }, { tools: { question: false } }, { tools: { "*": false } }]) {
    assert.equal(withInteractiveQuestionDefault(config), config);
  }
});

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
    await appendGroupEvent(home, group.id, { id: "evt_recovered", kind: "user", text: "After the crash" });
    await appendGroupEvent(home, group.id, { id: "evt_recovered", kind: "user", text: "After the crash" });
    await appendGroupEvent(home, group.id, { id: "evt_next", kind: "user", text: "Next" });
    assert.deepEqual((await readGroupTimeline(home, group.id)).map((event) => event.text), ["Hello both", "Hi", "After the crash", "Next"]);
    await writeFile(file, (await readFile(file, "utf8")).trimEnd());
    await appendGroupEvent(home, group.id, { kind: "user", text: "After a complete line without a newline" });
    assert.equal((await readGroupTimeline(home, group.id)).length, 5);
    assert.throws(() => parseTimeline('{"id":"evt_a","kind":"user","text":"a"}\nnot json\n{"id":"evt_b","kind":"user","text":"b"}\n'));

    await assert.rejects(appendGroupEvent(home, group.id, { kind: "coworker", text: "no slug" }), /names its coworker/);
    await assert.rejects(appendGroupEvent(home, group.id, { kind: "bogus", text: "x" }), /Unknown timeline event kind/);
    assert.equal((await readGroupTimeline(home, group.id, { limit: 1 })).length, 1);
  });
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

    const later = await createGroup(home, { name: "Other group", participantSlugs: ["scout", "editor"] }, { now: 0 });
    const finishing = await beginGroupTurn(home, later.id, { clientMessageId: "finishing", prompt: "Almost done" }, { now: 1 });
    await updateGroupTurn(home, later.id, finishing.turn.id, { speakers: [{ slug: "scout", status: "running" }] }, { now: 2 });
    await updateGroupTurn(home, group.id, active.turn.id, { speakers: [{ slug: "scout", status: "running" }] }, { now: 200 });
    let completion;
    await reconcileInterruptedGroupTurns(home, { nameFor: (slug) => {
      completion ??= updateGroupTurn(home, later.id, finishing.turn.id, { speaker: { slug: "scout", status: "succeeded" } });
      return slug;
    } });
    await completion;
    assert.equal((await getGroup(home, later.id)).turns[0].status, "succeeded", "recovery must not overwrite completion after its initial group listing");
    assert.equal((await readGroupTimeline(home, later.id)).length, 1);

    const linking = await beginGroupTurn(home, later.id, { clientMessageId: "linking", prompt: "Still owned by the queue" });
    const queue = [{ id: "linking", turnId: "" }];
    assert.deepEqual(await reconcileInterruptedGroupTurns(home, { isActive: (turn) => queue.some((entry) => entry.id === turn.clientMessageId || entry.turnId === turn.id) }), []);
    assert.equal((await getGroup(home, later.id)).turns.find((turn) => turn.id === linking.turn.id).status, "routing");
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
  const interactions = new Map();
  const decisions = [];
  let sequence = 0;
  const snapshot = (threadId) => ({ threadId, title: threadId, status: { type: held.has(threadId) ? "busy" : "idle" }, messages: histories.get(threadId) ?? [], todos: [] });
  return { requests, aborted, histories, held, interactions, decisions, clientFor: async (slug) => ({
    workspaceId: `workspace_${slug}`,
    pendingInteractions: async (threadId) => interactions.get(threadId) ?? { permissions: [], questions: [] },
    replyPermission: async (request, reply) => { decisions.push({ slug, request, reply }); interactions.delete(request.sessionID); held.delete(request.sessionID); },
    replyQuestion: async (request, answers) => { decisions.push({ slug, request, answers }); interactions.delete(request.sessionID); held.delete(request.sessionID); },
    rejectQuestion: async (request) => { decisions.push({ slug, request, reply: "reject" }); interactions.delete(request.sessionID); held.delete(request.sessionID); },
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

test("shutdown drains late setup writes and seals collaboration storage before returning", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const release = Promise.withResolvers();
    let started = false;
    const service = createCollaboration({ directory: home, pollMs: 5, setupTimeoutMs: 100,
      clientFor: async (slug) => {
        started = true;
        await release.promise;
        await writeFile(path.join(home, "late-setup"), "last write");
        return fixture.clientFor(slug);
      },
    });
    try {
      await service.submit({ owner: { slug: "scout", threadId: "shutdown", conversationId: "shutdown", kind: "private" }, prompt: "Queued setup" });
      await eventually(() => started);
      // Cancellation finishes its observer, but not the underlying setup write.
      await assert.rejects(service.stop({ requireConfirmed: true }), /did not finish stopping/);
      await stat(home);
      release.resolve();
      await service.stop({ requireConfirmed: true });
      assert.equal(await readFile(path.join(home, "late-setup"), "utf8"), "last write");
      await rm(home, { recursive: true });
      await assert.rejects(service.registerOwner({ slug: "scout", threadId: "late", conversationId: "late", kind: "private" }), /storage is closed/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(stat(home), { code: "ENOENT" });
    } finally { release.resolve(); await service.stop(); }
  });
});

test("shutdown refuses unconfirmed native cancellation instead of swallowing it", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ threadId }) => { fixture.held.add(threadId); });
    const service = createCollaboration({ directory: home, pollMs: 5, setupTimeoutMs: 100,
      clientFor: async (slug) => ({ ...await fixture.clientFor(slug), abortThread: async () => ({ accepted: false }) }),
    });
    try {
      await service.submit({ owner: { slug: "scout", threadId: "shutdown", conversationId: "shutdown", kind: "private" }, prompt: "Hold this step" });
      await eventually(() => fixture.requests.length === 1);
      await assert.rejects(service.stop({ requireConfirmed: true }), /native cleanup could not be confirmed/);
      assert.equal((await stat(home)).isDirectory(), true);
    } finally { fixture.held.clear(); await service.stop(); }
  });
});

test("shutdown retains group participant ownership until a cancelled raw write settles", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "editor"] });
    const release = Promise.withResolvers();
    const signal = new AbortController();
    let started = false;
    const groups = createGroupExecution({ directory: home, setupTimeoutMs: 20,
      clientFor: async () => ({ createThread: async () => ({ id: "participant" }) }),
      collaboration: { registerOwner: async () => { started = true; await release.promise; await writeFile(path.join(home, "late-owner"), "last write"); } },
    });
    try {
      const participant = groups.participant(group.id, "scout", signal.signal);
      const rejected = assert.rejects(participant, /Cancelled/);
      await eventually(() => started);
      signal.abort(new Error("Cancelled"));
      await rejected;
      await assert.rejects(groups.stop(), /did not finish stopping/);
      release.resolve();
      await groups.stop();
      assert.equal(await readFile(path.join(home, "late-owner"), "utf8"), "last write");
      await rm(home, { recursive: true });
      await assert.rejects(groups.participant(group.id, "editor"), /closing/);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await assert.rejects(stat(home), { code: "ENOENT" });
    } finally { release.resolve(); await groups.stop(); }
  });
});

test("fresh admission waits through an idle unfinished placeholder", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    let polls = 0;
    const service = createCollaboration({ directory: home, pollMs: 5, consult: async () => {}, spawn: async () => {}, cancelWorker: async () => {}, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client, waitForThread: async (...args) => {
        const result = await client.waitForThread(...args);
        if (++polls !== 1) return result;
        return { ...result, outcome: "timeout", snapshot: { ...result.snapshot, messages: result.snapshot.messages.map((message) => message.role === "assistant" ? { ...message, completedAt: null } : message) } };
      } };
    } });
    try {
      const entry = await service.submit({ owner: { slug: "scout", threadId: "ses_placeholder", conversationId: "ses_placeholder", kind: "private" }, messageId: "msg_placeholder", prompt: "Wait for the real reply" });
      await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "succeeded");
      assert.equal(polls, 2);
      assert.equal(fixture.requests.length, 1);
    } finally { await service.stop(); }
  });
});

test("only explicit private requests may ask for Worker control and cancellation invalidates authority before persistence", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const invalidated = [];
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      spawn: async (_slug, input) => ({ id: input.id, status: "paused" }), cancelWorker: async () => {}, invalidateWorker: (slug, id) => invalidated.push({ slug, id }),
    });
    try {
      const owner = { kind: "private", slug: "scout", threadId: "origin", conversationId: "origin" };
      const entry = await service.submit({ owner, messageId: "control-request", prompt: "Review this draft", track: true });
      const input = { name: "Review", goal: "Review draft", control: "browser" };
      for (const patch of [{ personRequest: false }, { continuation: true }, { owner: { ...owner, kind: "group" } }, { owner: { ...owner, kind: "assignment" } }]) await assert.rejects(service.request({ entry: { ...entry, ...patch }, callId: "not-allowed" }, "worker", input), /explicit person request/);
      await assert.rejects(service.request({ entry, callId: "thinker" }, "worker", { ...input, purpose: "thinking" }), /delivery Worker/);
      const requested = await service.request({ entry, callId: "approved-request" }, "worker", input);
      const worker = { slug: "scout", id: requested.structured.worker.id, spawnedFromThreadId: "origin", control: { surface: "browser" } };
      await eventually(async () => (await service.read((state) => state.tasks[requested.structured.collaboration.id])).state === "waiting");
      const permission = await service.workerControlTask(worker);
      permission.assertActive();
      await assert.rejects(service.workerControlTask({ ...worker, spawnedFromThreadId: "other" }), /original Worker control/);
      await mkdir(path.join(home, ".collaboration", "state.json.tmp"));
      const cancelling = service.cancel(entry.id);
      assert.deepEqual(invalidated, [{ slug: "scout", id: worker.id }]);
      assert.throws(permission.assertActive, /stopped/);
      await assert.rejects(cancelling);
      assert.equal(fixture.requests.some((request) => request.prompt.startsWith("Continue the original task")), false);
    } finally { await service.stop(); }
  });
});

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
    } finally { await groups.stop(); await service.stop(); }
  });
});

test("one thinking brief permits a bounded delivery handoff, and unavailable Workers return a failure to the origin", async () => {
  await withHome(async (home) => {
    let service;
    const spawned = [];
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      const trusted = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
      const ask = (callId, purpose, name = purpose) => service.request({ ...trusted, callId }, "worker", { name, purpose, goal: "Use workspace/brief.md; check acceptance criteria.", continuation: { objective: "Deliver the original task", refs: ["workspace/brief.md"], resumeInstructions: "Check the evidence and report here." } });
      if (input.prompt === "Start with ambiguity") {
        await ask("thinking", "thinking");
        await assert.rejects(ask("extra-thinker", "thinking"), /at most one thinking brief/);
        await assert.rejects(ask("premature-delivery", "delivery"), /completed thinking brief/);
      } else if (["Empty thinker", "Exhausted thinker", "Empty Done"].includes(input.prompt)) {
        await ask("incomplete-thinker", "thinking", input.prompt);
      } else if (input.prompt === "Unavailable model") {
        await ask("unavailable", "delivery", "Unavailable");
      } else if (input.prompt.includes("THINKING BRIEF") && !input.prompt.includes("DELIVERY EVIDENCE")) {
        await ask("delivery-one", "delivery");
        await ask("delivery-two", "delivery");
        await assert.rejects(ask("delivery-three", "delivery"), /collaboration limit/);
        await assert.rejects(ask("another-thinker", "thinking"), /at most one thinking brief/);
      } else {
        await assert.rejects(ask("recursive-delivery", "delivery"), /collaboration limit|completed thinking brief/);
      }
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, cancelWorker: async () => {},
      spawn: async (slug, input) => {
        spawned.push(input);
        if (input.name === "Unavailable") throw new Error("Worker model is unavailable; no fallback was selected.");
        let worker = await createWorker(home, slug, { ...input, spawnedBy: "coworker" });
        for (let turn = 0; turn < 2; turn++) {
          const reply = input.name === "Empty thinker" ? "" : input.name === "Exhausted thinker" ? "## Finding\nStill comparing workspace/brief.md" : input.name === "Empty Done" ? "## Done" : `## Done\n${input.purpose === "thinking" ? "THINKING BRIEF: workspace/brief.md" : "DELIVERY EVIDENCE: workspace/result.md"}`;
          const step = nextWorkerState(worker, { kind: "settled", report: parseWorkerReport(reply) });
          worker = await updateWorker(home, slug, worker.id, step.patch);
          await service.completeWorker(worker, step.events);
          if (step.schedule === "stop") break;
        }
        return worker;
      },
    });
    try {
      const owner = { slug: "scout", threadId: "ses_brief_origin", conversationId: "ses_brief_origin", kind: "private" };
      const first = await service.submit({ owner, messageId: "msg_thinking", prompt: "Start with ambiguity", track: true });
      await eventually(async () => (await service.read((state) => state.tasks[first.taskId])).state === "succeeded");
      assert.deepEqual(spawned.map((input) => input.purpose), ["thinking", "delivery", "delivery"]);
      assert.equal(fixture.requests.length, 3, "one original turn and two handbacks, not a recursive tree");
      assert.match(fixture.requests[2].prompt, /DELIVERY EVIDENCE/);
      assert.ok(fixture.requests.every((request) => request.threadId === owner.threadId));
      const failed = await service.submit({ owner, messageId: "msg_unavailable", prompt: "Unavailable model", track: true });
      await eventually(async () => (await service.read((state) => state.tasks[failed.taskId])).state === "succeeded");
      assert.match(fixture.requests.at(-1).prompt, /Worker model is unavailable; no fallback/);
      assert.equal(spawned.length, 4, "failure is reported, not retried on a different model");
      const manual = { slug: owner.slug, id: "wrk_manualthinker", name: "Manual brief", purpose: "thinking", goal: "Deliver the original task", status: "finished" };
      await service.attachWorker(manual, owner);
      await service.completeWorker(manual, [{ kind: "finding", report: "done", text: "THINKING BRIEF: workspace/brief.md" }]);
      await eventually(() => fixture.requests.length === 7);
      await eventually(async () => (await service.receipts({ slug: owner.slug, threadId: owner.threadId })).every((receipt) => receipt.state === "succeeded"));
      assert.deepEqual(spawned.slice(4).map((input) => input.purpose), ["delivery", "delivery"], "a thinking Worker from New Worker uses the same bounded handoff");
      for (const prompt of ["Empty thinker", "Exhausted thinker", "Empty Done"]) {
        const before = spawned.length;
        const entry = await service.submit({ owner, messageId: nativeMessageId(), prompt, track: true });
        await eventually(async () => (await service.read((state) => state.tasks[entry.taskId])).state === "succeeded");
        const child = await service.read((state) => state.tasks[state.tasks[entry.taskId].dependencies[0]]);
        assert.equal(child.state, "failed");
        assert.equal(child.briefReady, false);
        assert.match(child.error, /^Incomplete:/);
        assert.equal(spawned.length, before + 1, "an incomplete thinking result never launches delivery");
        assert.match(fixture.requests.at(-1).prompt, /Incomplete:/, "the original coworker receives the incomplete result");
      }
    } finally { await service.stop(); }
  });
});

test("completion before yield, restart delivery, and cancellation do not duplicate or resurrect a continuation", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const stopped = [];
    let cleanupFails = false;
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5, consult: async () => { throw new Error("Not used"); }, spawn: async () => { throw new Error("Not used"); }, cancelWorker: async (_slug, id) => { stopped.push(id); if (cleanupFails) throw new Error("Native cleanup unavailable"); } };
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
      cleanupFails = true;
      await assert.rejects(service.cancel(next.id), /could not be confirmed/);
      cleanupFails = false;
      await service.cancel(next.id);
      assert.deepEqual(stopped, [child.structured.worker.id, child.structured.worker.id], "repeat Stop repairs cleanup even after the collaboration is terminal");
      await service.completeWorker({ id: child.structured.worker.id, slug: "scout", status: "finished" }, [{ kind: "finding", text: "LATE RESULT" }]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await service.receipts({ slug: "scout", threadId: "ses_cancel" }))[0].state, "cancelled");
      assert.equal(fixture.requests.some((request) => request.threadId === "ses_cancel" && request.prompt.includes("LATE RESULT")), false);
    } finally { await service.stop(); }
  });
});

test("Workers stay requested until parent success and return corrections or exhausted work honestly once", async () => {
  await withHome(async (home) => {
    let service;
    let requested;
    const spawned = [];
    const turns = [];
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (!input.prompt.startsWith("Original: ")) return;
      const context = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
      requested = await service.request(context, "worker", { name: input.prompt.slice(10), goal: "Produce result.md covering source A and the accepted corrections." });
      fixture.held.add(threadId);
      if (input.prompt.endsWith("parent failure")) reply.error = { message: "The foreground reply failed." };
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, cancelWorker: async () => {}, spawn: async (slug, input) => {
      assert.equal(await service.read((state) => state.executions[state.tasks[state.tasks[requested.structured.collaboration.id].parentId].executionId].state), "succeeded");
      spawned.push(input.name);
      const expired = input.name === "expired before admission";
      const lifespan = expired ? { kind: "until", at: Date.now() - 1 } : { kind: "turns", max: input.name === "correction remaining" ? 2 : 1 };
      let worker = await createWorker(home, slug, { ...input, lifespan, spawnedBy: "coworker" }, { now: Date.now() - 1000 });
      for (let turn = 0; turn < 2; turn++) {
        if (!expired) {
          const prepared = await prepareWorkerTurn(home, slug, worker.id, "Scout");
          turns.push(prepared.pendingTurn);
          if (turn === 0 && input.name.startsWith("correction")) await queueWorkerSteer(home, slug, worker.id, "Include source C in result.md.", "person");
          if (turn === 1) {
            assert.match(prepared.pendingTurn.prompt, /Include source C in result.md/);
            assert.notEqual(prepared.pendingTurn.messageId, turns.at(-2).messageId);
          }
        }
        let step;
        worker = await updateWorker(home, slug, worker.id, (current) => {
          step = nextWorkerState(current, { kind: "settled", report: expired ? { kind: "none", text: "" } : { kind: input.name === "delivery exhausted" ? "finding" : "done", text: turn === 0 ? "Only source A is in result.md." : "Sources A and C are in result.md." } });
          return { ...step.patch, pendingTurn: null };
        });
        await service.completeWorker(worker, step.events);
        if (step.schedule === "stop") {
          await service.completeWorker(worker, step.events);
          break;
        }
      }
      return worker;
    } });
    try {
      const owner = { slug: "scout", threadId: "ses_worker_outcome", conversationId: "ses_worker_outcome", kind: "private" };
      for (const name of ["correction remaining", "correction exhausted", "delivery exhausted", "expired before admission", "parent failure"]) {
        requested = null;
        const before = spawned.length;
        const root = await service.submit({ owner, prompt: `Original: ${name}`, messageId: nativeMessageId(), track: true });
        await eventually(() => requested && fixture.held.has(owner.threadId));
        assert.equal(requested.structured.worker.action, "requested");
        assert.equal(requested.structured.collaboration.state, "requested");
        await new Promise((resolve) => setTimeout(resolve, 25));
        assert.equal(spawned.length, before, "no child spawns while the foreground reply is active");
        fixture.held.delete(owner.threadId);
        await eventually(async () => ["failed", "succeeded"].includes((await service.read((state) => state.tasks[root.taskId])).state));
        const child = await service.read((state) => state.tasks[requested.structured.collaboration.id]);
        const followups = fixture.requests.filter((request) => request.prompt.startsWith("Continue the original task") && request.prompt.includes(`Objective: Original: ${name}`));
        if (name === "parent failure") {
          assert.equal(spawned.length, before, "the deliberate parent-success gate is retained");
          assert.equal(followups.length, 0);
          continue;
        }
        assert.equal(spawned.length, before + 1);
        assert.equal(followups.length, 1);
        const worker = await getWorker(home, "scout", child.workerId);
        assert.equal(child.state, name === "correction remaining" ? "succeeded" : "failed");
        assert.equal(worker.status, name === "correction remaining" ? "finished" : "failed");
        assert.equal(child.reportKind, name === "delivery exhausted" ? "finding" : name === "expired before admission" ? "none" : "done");
        if (name !== "correction remaining") assert.match(child.error, /^Incomplete:/);
        if (name === "correction exhausted") {
          assert.equal(child.unresolvedSteers[0].text, "Include source C in result.md.");
          assert.match(followups[0].prompt, /accepted correction still unresolved/);
        }
        if (name === "correction remaining") assert.match(child.result, /Sources A and C/);
        assert.match(followups[0].prompt, /Inspect the returned result and referenced artifacts against the original acceptance criteria/);
        assert.match(followups[0].prompt, /spent lifespan is not completion/);
      }
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
      await assert.rejects(groups.remove(group.id, "parallel"), /already started/);
      await groups.submit(group.id, { clientMessageId: "queued-removal", text: "@everyone This queued message will be removed." });
      await groups.remove(group.id, "queued-removal");
      assert.deepEqual(await service.read((state) => state.groups[group.id].queue.map((entry) => entry.id)), ["parallel"]);
      await groups.cancel(group.id);
      await eventually(async () => !(await groups.status(group.id)).active);
      assert.ok(threads.every((id) => fixture.aborted.includes(id)));
      assert.deepEqual((await getGroup(home, group.id)).turns[0].speakers.map((speaker) => speaker.status), ["stopped", "stopped"]);

      await groups.submit(group.id, { clientMessageId: "parallel-completed", text: "@everyone Another independent check." });
      await eventually(() => fixture.requests.filter((request) => request.slug !== ".coordinator").length === 4);
      const editor = fixture.requests.filter((request) => request.slug === "editor").at(-1);
      fixture.held.delete(editor.threadId);
      await eventually(async () => (await service.activityEntries({ groupId: group.id })).some((entry) => entry.messageId === editor.messageId && entry.state === "succeeded"));
      const buffered = await groups.activity(group.id, (scope) => service.activityEntries(scope));
      assert.ok(buffered.executions.some((entry) => entry.messageId === editor.messageId));
      assert.equal(buffered.timeline.filter((event) => event.kind === "coworker").length, 0);
      const handedOff = await groups.activity(group.id, async (scope) => {
        const before = await service.activityEntries(scope);
        await groups.cancel(group.id);
        await eventually(async () => !(await groups.status(group.id)).active);
        return before;
      });
      assert.equal(handedOff.timeline.filter((event) => event.kind === "coworker" && event.slug === "editor").length, 1);
      assert.equal(handedOff.executions.some((entry) => entry.messageId === editor.messageId), false, "publication between activity and timeline reads must not duplicate the reply");
      assert.deepEqual((await getGroup(home, group.id)).turns[1].speakers.map((speaker) => speaker.status), ["stopped", "succeeded"]);
    } finally { await groups.stop(); await service.stop(); }
  });
});

test("backend Next drains without a view and results queue behind a foreground reply", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, consult: async () => {}, spawn: async (_slug, input) => ({ id: input.id, status: "running" }), cancelWorker: async () => {} });
    const owner = { slug: "scout", threadId: "ses_queue", conversationId: "ses_queue", kind: "private" };
    try {
      const empty = await service.threadState(owner.slug, owner.threadId);
      const root = await service.submit({ owner, messageId: "msg_queue", prompt: "Original", track: true });
      const admitted = await service.threadState(owner.slug, owner.threadId);
      assert.ok((await service.updateThread(owner.slug, owner.threadId, admitted, { ...admitted, pending: null })).pending, "a stale clear cannot remove an active backend admission");
      const child = await service.request({ entry: root, callId: "child" }, "worker", { name: "Check", goal: "Check once" });
      const before = await service.threadState(owner.slug, owner.threadId);
      await service.updateThread(owner.slug, owner.threadId, before, { ...before, next: [{ id: "next_a", text: "Foreground next", queuedAt: Date.now() }] });
      await service.completeWorker({ slug: "scout", id: child.structured.worker.id, status: "finished" }, [{ kind: "finding", text: "READY" }]);
      await eventually(async () => (await service.receipts({ slug: owner.slug, threadId: owner.threadId }))[0]?.state === "succeeded");
      assert.equal(fixture.requests[1].prompt, "Foreground next");
      assert.match(fixture.requests[2].prompt, /^Continue the original task/);
      assert.ok(fixture.requests[1].messageId < fixture.requests[2].messageId, "native IDs follow admission order, not continuation creation order");
      assert.equal((await service.threadState(owner.slug, owner.threadId)).next.length, 0);
      const stale = await service.updateThread(owner.slug, owner.threadId, empty, { ...admitted, next: [{ id: "after_settlement", text: "Still drains", queuedAt: Date.now() }] });
      assert.equal(stale.pending, null, "a completed pending turn cannot be resurrected by a late client write");
      await eventually(() => fixture.requests.some((request) => request.prompt === "Still drains"));
      await eventually(async () => (await service.threadState(owner.slug, owner.threadId)).pending === null);
    } finally { await service.stop(); }
  });
});

test("group continuations yield to routing and all foreground speakers, including a request arriving during setup", async () => {
  await withHome(async (home) => {
    let service;
    let child;
    let routing = false;
    let releaseRoute;
    const routeGate = new Promise((resolve) => { releaseRoute = resolve; });
    let releaseSetup;
    const setupGate = new Promise((resolve) => { releaseSetup = resolve; });
    let holdSetup = false;
    let preparing = false;
    const setups = [];
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (slug === ".coordinator") {
        const message = input.prompt.split("The person's message:").at(-1).split("\nMention hints:")[0];
        const addressedSlugs = message.includes("@scout") ? ["scout"] : [];
        reply.parts.push({ type: "text", text: JSON.stringify({ addressedSlugs, speakers: (addressedSlugs.length ? addressedSlugs : ["scout", "editor"]).map((slug) => ({ slug })), mode: "sequential" }) });
      }
      else if (!child && input.prompt.includes("Delegate the original")) {
        const trusted = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
        child = await service.request(trusted, "worker", { name: "Group check", goal: "Check result.md" });
      } else if (slug === "editor") fixture.held.add(threadId);
    });
    service = createCollaboration({ directory: home, pollMs: 5, spawn: async (_slug, input) => ({ id: input.id, status: "running" }), cancelWorker: async () => {}, clientFor: async (slug, options = {}) => {
      setups.push({ slug, ...options });
      if (holdSetup && options.kind === "review") { preparing = true; await setupGate; }
      return fixture.clientFor(slug);
    } });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, pollMs: 5,
      coworkerFor: async (slug) => ({ slug, name: slug, role: "Research and architecture", mission: "Deep analysis", model: "test/model" }),
      coordinator: async () => { if (child) { routing = true; await routeGate; } return { workspaceId: "coordinator" }; },
      catalogFor: async () => ({ models: [{ id: "test/model", providerId: "test", modelId: "model", variants: [], source: "local", tier: "key", toolCall: true, status: "active", label: "Test", releaseDate: "" }] }),
    });
    try {
      const group = await createGroup(home, { name: "Pair", participantSlugs: ["scout", "editor"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "origin", text: "@scout Delegate the original", context: "Wrapper: investigate every role thoroughly." });
      await eventually(async () => child && !(await groups.status(group.id)).active);
      await groups.submit(group.id, { clientMessageId: "human-next", text: "Hello" });
      await eventually(() => routing);
      await service.completeWorker({ slug: "scout", id: child.structured.worker.id, status: "finished" }, [{ kind: "finding", report: "done", text: "Group result.md is ready" }]);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(setups.some((entry) => entry.kind === "review"), false, "queued routing wins before continuation setup");
      releaseRoute();
      await eventually(() => fixture.requests.some((entry) => entry.slug === "editor" && fixture.held.has(entry.threadId)));
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(setups.some((entry) => entry.kind === "review"), false, "another speaker keeps the foreground turn ahead");
      assert.ok(setups.some((entry) => entry.slug === "editor" && entry.requestText === "Hello"), "effort receives the raw request, not role or prompt wrappers");
      fixture.held.clear();
      await eventually(async () => (await service.receipts({ groupId: group.id }))[0]?.state === "succeeded");
      assert.equal(setups.find((entry) => entry.kind === "review").requestText, "@scout Delegate the original");
      const origin = await service.read((state) => state.tasks[state.tasks[child.structured.collaboration.id].parentId]);
      holdSetup = true;
      const worker = { id: "wrk_groupsecond", slug: "scout", name: "Another result", goal: "Finish the group task", status: "finished" };
      await service.attachWorker(worker, origin.owner);
      await service.completeWorker(worker, [{ kind: "finding", report: "done", text: "Second result.md" }]);
      await eventually(() => preparing);
      await groups.submit(group.id, { clientMessageId: "during-setup", text: "@scout Please read the correction" });
      holdSetup = false;
      releaseSetup();
      await eventually(async () => (await service.receipts({ groupId: group.id })).every((receipt) => receipt.state === "succeeded"));
      const correction = fixture.requests.findIndex((entry) => entry.prompt.includes("Please read the correction"));
      const followup = fixture.requests.findIndex((entry) => entry.prompt.includes("Second result.md"));
      assert.ok(correction >= 0 && followup > correction, "the final admission check lets the human turn overtake prepared continuation setup");
      assert.equal(fixture.requests.filter((entry) => entry.prompt.includes("Second result.md")).length, 1);
    } finally { releaseRoute(); releaseSetup(); await groups.stop(); await service.stop(); }
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

test("private Continue uses a new admission, keeps tool effects once and fences the old dependency generation", async () => {
  await withHome(async (home) => {
    let effects = 0;
    let service;
    let child;
    const fixture = nativeFixture(async ({ input, reply, threadId }) => {
      if (input.prompt !== "Write once then fail") return;
      effects++;
      await writeFile(path.join(home, "effect.txt"), String(effects));
      const trusted = await service.context("scout", { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
      child = await service.request(trusted, "worker", { name: "Old generation", goal: "Check", continuation: { objective: "Finish the receipt", refs: ["effect.txt"], completedActions: ["Wrote effect.txt once"], resumeInstructions: "Read the receipt without writing again." } });
      reply.error = { message: "Interrupted after writing" };
    });
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5, cancelWorker: async () => {} };
    service = createCollaboration(options);
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_once", conversationId: "ses_once", kind: "private" }, messageId: "msg_once", prompt: "Write once then fail", track: true });
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "failed" && fixture.aborted.length > 0);
      const history = structuredClone(fixture.histories.get("ses_once"));
      await assert.rejects(service.submit({ ...root, retry: true }), /Choose Continue/);
      const next = await service.submit({ ...root, retry: true, retryByPerson: true });
      assert.notEqual(next.messageId, root.messageId);
      assert.equal(next.owner.threadId, root.owner.threadId);
      assert.match(next.prompt, /Objective: Finish the receipt/);
      assert.match(next.prompt, /References: native message msg_once; effect.txt/);
      assert.match(next.prompt, /Already completed: Wrote effect.txt once/);
      assert.match(next.prompt, /outcome is uncertain, ask the person/);
      assert.equal((await service.submit({ ...root, retry: true, retryByPerson: true })).id, next.id);
      await service.completeWorker({ slug: "scout", id: child.structured.worker.id, status: "finished" }, [{ kind: "finding", text: "LATE OLD RESULT" }]);
      await service.cancel(root.id);
      await eventually(async () => (await service.read((state) => state.executions[next.id])).state === "succeeded");
      assert.equal(effects, 1);
      assert.equal(await readFile(path.join(home, "effect.txt"), "utf8"), "1");
      assert.deepEqual(fixture.histories.get("ses_once").slice(0, history.length), history);
      assert.equal((await service.read((state) => state.executions[root.id])).state, "failed");
      assert.equal(fixture.requests.length, 2);
      await service.stop();
      service = createCollaboration(options);
      await service.start();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(fixture.requests.length, 2);
    } finally { await service.stop(); }
  });
});

test("group human waits release capacity but retain their session lock and exact request binding", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ input, reply, threadId }) => {
      if (input.prompt === "Other work can proceed") fixture.held.add(threadId);
      if (!input.prompt.startsWith("Wait")) return;
      fixture.held.add(threadId);
      const tool = { messageID: reply.id, callID: reply.parts[0].callId };
      fixture.interactions.set(threadId, { permissions: [{ id: "permission_a", sessionID: threadId, protocol: "legacy", action: "bash", resources: ["safe canary"], canAlways: false, tool }, { id: "PRIVATE_REQUEST", sessionID: "ses_private", tool }], questions: [{ id: "STALE_REQUEST", sessionID: threadId, tool: { messageID: "old-assistant", callID: "old-call" } }] });
    });
    const options = { directory: home, clientFor: fixture.clientFor, maxActiveExecutions: 1, pollMs: 5 };
    const service = createCollaboration(options);
    const owner = { slug: "scout", threadId: "ses_group", conversationId: "grp_a", groupId: "grp_a", kind: "group" };
    try {
      const first = await service.submit({ owner, messageId: "msg_wait", prompt: "Wait for permission" });
      await eventually(async () => (await service.read((state) => state.executions[first.id])).state === "waiting-person");
      const waits = await service.groupInteractions("grp_a");
      assert.equal((await service.activityEntries({ groupId: "grp_a" }))[0].state, "waiting-person", "waiting on a person retains the execution's visible reply");
      assert.deepEqual(waits[0].pending.permissions.map((request) => request.id), ["permission_a"]);
      assert.deepEqual(waits[0].pending.questions, []);
      assert.deepEqual(await service.groupInteractions("grp_other"), []);
      const sameSession = await service.submit({ owner, messageId: "msg_later", prompt: "Second producer must wait" });
      const elsewhere = await service.submit({ owner: { slug: "editor", threadId: "ses_elsewhere", conversationId: "ses_elsewhere", kind: "private" }, messageId: "msg_elsewhere", prompt: "Other work can proceed" });
      await eventually(() => fixture.held.has("ses_elsewhere"));
      assert.equal((await service.read((state) => state.executions[sameSession.id])).state, "queued");
      const binding = { groupId: "grp_a", executionId: first.id, slug: "scout", threadId: owner.threadId, workspaceId: "workspace_scout", requestId: "permission_a", kind: "permission", reply: "once" };
      for (const patch of [{ groupId: "grp_other" }, { slug: "editor" }, { threadId: "ses_private" }, { workspaceId: "workspace_editor" }, { executionId: elsewhere.id }, { requestId: "PRIVATE_REQUEST" }]) await assert.rejects(service.replyInteraction({ ...binding, ...patch }), /no longer/);
      await assert.rejects(service.replyInteraction({ ...binding, reply: "always" }), /not offered/);
      await assert.rejects(service.replyInteraction(binding), /available execution slots/);
      assert.equal(fixture.decisions.length, 0);
      fixture.held.delete("ses_elsewhere");
      await eventually(async () => (await service.read((state) => state.executions[elsewhere.id])).state === "succeeded");
      await service.replyInteraction(binding);
      await assert.rejects(service.replyInteraction(binding), /no longer/);
      await eventually(async () => (await service.read((state) => state.executions[sameSession.id])).state === "succeeded");
      assert.equal(fixture.requests.filter((request) => request.messageId === first.messageId).length, 1);
      assert.equal(fixture.decisions.length, 1);
      assert.equal((await service.read((state) => state.executions[first.id])).state, "succeeded");
    } finally { await service.stop(); }
  });
});

test("a dependency-free tool-free retry retains its message ID", async () => {
  await withHome(async (home) => {
    let attempt = 0;
    let retries = 0;
    const fixture = nativeFixture(async ({ reply }) => { reply.parts = []; if (++attempt === 1) reply.error = { message: "Provider unavailable" }; });
    const service = createCollaboration({ directory: home, pollMs: 5, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client, retryTurn: async (threadId, input) => { retries++; fixture.histories.set(threadId, []); return client.sendTurn(threadId, input); } };
    } });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_tool_free", conversationId: "ses_tool_free", kind: "private" }, messageId: "msg_tool_free", prompt: "Reply without tools" });
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "failed" && fixture.aborted.length > 0);
      const retry = await service.submit({ ...root, retry: true, retryByPerson: true });
      assert.equal(retry.messageId, root.messageId);
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "succeeded");
      assert.equal(retries, 1);
      assert.equal(fixture.histories.get(root.owner.threadId).filter((message) => message.role === "user").length, 1);
    } finally { await service.stop(); }
  });
});

test("a recovered group question observes the same admission; cancel and expired waits reject late answers", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const owner = { slug: "scout", threadId: "ses_question", conversationId: "grp_question", groupId: "grp_question", kind: "group" };
    let clock = Date.now();
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5, now: () => clock, personTimeoutMs: 1000 };
    let service = createCollaboration(options);
    try {
      const root = await service.submit({ owner, messageId: "msg_question", prompt: "Question already admitted" });
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "succeeded");
      await service.stop();
      const reply = fixture.histories.get(owner.threadId).at(-1);
      const question = { id: "question_a", sessionID: owner.threadId, questions: [{ header: "Choose", question: "Which?", options: [{ label: "A", description: "One" }], custom: false, multiple: false }], tool: { messageID: reply.id, callID: reply.parts[0].callId } };
      // Simulate a crash while the native producer is still waiting, not a second send.
      // A stopped service is sealed; seed recovery through a separate fixture store.
      service = createCollaboration(options);
      await service.change((state) => { Object.assign(state.executions[root.id], { state: "waiting-person", personDeadline: clock + 1000, remainingMs: 2000, interactions: { permissions: [], questions: [{ id: question.id }] } }); state.tasks[root.taskId].state = "waiting-person"; });
      await service.stop();
      fixture.held.add(owner.threadId);
      fixture.interactions.set(owner.threadId, { permissions: [], questions: [question] });
      service = createCollaboration(options);
      await service.start();
      await eventually(async () => (await service.groupInteractions(owner.groupId))[0]?.pending.questions.length === 1);
      const binding = { groupId: owner.groupId, executionId: root.id, slug: owner.slug, threadId: owner.threadId, workspaceId: "workspace_scout", requestId: question.id, kind: "question", answers: [["A"]] };
      await service.replyInteraction(binding);
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "succeeded");
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.decisions[0].answers, [["A"]]);
      for (const mode of ["cancel", "expire"]) {
        const client = await fixture.clientFor(owner.slug);
        const entry = await service.submit({ owner, messageId: `msg_${mode}`, prompt: mode });
        await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "succeeded");
        const latest = (await client.getThreadSnapshot(owner.threadId)).messages.at(-1);
        fixture.interactions.set(owner.threadId, { permissions: [], questions: [{ ...question, tool: { messageID: latest.id, callID: latest.parts[0].callId } }] });
        fixture.held.add(owner.threadId);
        await service.change((state) => { Object.assign(state.executions[entry.id], { state: "waiting-person", personDeadline: clock + 1000, remainingMs: 2000 }); state.tasks[entry.taskId].state = "waiting-person"; });
        await eventually(async () => (await service.groupInteractions(owner.groupId))[0]?.pending.questions.length === 1);
        if (mode === "cancel") await service.cancel(entry.id);
        else clock += 2000;
        await assert.rejects(service.replyInteraction({ ...binding, executionId: entry.id }), /no longer/);
        await eventually(async () => ["failed", "cancelled"].includes((await service.read((state) => state.executions[entry.id])).state));
      }
      assert.equal(fixture.decisions.length, 1);
    } finally { await service.stop(); }
  });
});

test("shared native interaction helpers tolerate an absent v2 HTML route without hiding real failures", async (t) => {
  let mode = "html";
  const replies = [];
  t.mock.method(globalThis, "fetch", async (request) => {
    const url = new URL(request.url);
    const v2 = url.pathname.includes("/api/session/");
    if (request.method === "POST") { replies.push({ path: url.pathname, body: await request.json() }); return Response.json(true); }
    if (v2 && mode === "html") return new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });
    if (v2 && mode === "forbidden") return Response.json({ error: "Denied" }, { status: 403 });
    if (v2 && mode === "server-error") return new Response("Unavailable", { status: 503, headers: { "content-type": "text/html" } });
    if (!v2 && url.pathname.endsWith("/question") && mode === "question-error") return Response.json({ error: "Unavailable" }, { status: 500 });
    if (v2) return Response.json({ data: [{ id: "v2-a", sessionID: "ses_a", action: "edit", resources: ["a.md"], source: { type: "tool", messageID: "assistant_a", callID: "call_a" } }] });
    if (url.pathname.endsWith("/question")) return Response.json([]);
    return Response.json([{ id: "legacy-a", sessionID: "ses_a", permission: "bash", patterns: ["safe"], always: [], tool: { messageID: "assistant_a", callID: "call_a" } }, { id: "private", sessionID: "ses_private", permission: "bash", patterns: ["PRIVATE"], always: [] }]);
  });
  const threads = createCoworkerThreads({ serverUrl: "http://127.0.0.1:1", workspaceId: "workspace_a", token: "fixture" });
  const legacy = await threads.listThreadInteractions("ses_a");
  assert.deepEqual(legacy.permissions.map((request) => request.id), ["legacy-a"]);
  assert.deepEqual(legacy.permissions[0].tool, { messageID: "assistant_a", callID: "call_a" });
  for (mode of ["forbidden", "server-error", "question-error"]) await assert.rejects(threads.listThreadInteractions("ses_a"), /Reading .* failed/);
  mode = "json";
  const native = await threads.listThreadInteractions("ses_a");
  assert.equal(native.permissions.length, 2);
  await threads.replyPermission(native.permissions[1], "once");
  assert.match(replies[0].path, /workspace\/workspace_a\/opencode\/api\/session\/ses_a\/permission\/v2-a\/reply/);
  assert.deepEqual(replies[0].body, { reply: "once" });
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
      // Parent settlement may admit either child first; cancellation must fence
      // the other child regardless of which preparation is already in flight.
      const firstPrepared = called[0];
      assert.ok(firstPrepared === "editor" || firstPrepared === "ops");
      await service.cancel(root.taskId);
      release();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(called, [firstPrepared]);
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
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5 };
    let service = createCollaboration(options);
    const groupOptions = { directory: home, clientFor: fixture.clientFor, pollMs: 5, coworkerFor: async (slug) => ({ slug, name: slug, role: "", mission: "" }) };
    let groups = createGroupExecution({ ...groupOptions, collaboration: service });
    try {
      const group = await createGroup(home, { name: "Pair", participantSlugs: ["scout", "editor"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "first-tool-attempt", text: "@scout Finish the bounded task" });
      await eventually(async () => !(await groups.status(group.id)).active);
      const failed = (await getGroup(home, group.id)).turns[0];
      assert.equal(failed.status, "failed");
      const original = await service.read((state) => Object.values(state.executions)[0]);
      const followUp = { clientMessageId: "explicit-follow-up", text: failed.prompt, turnId: failed.id };
      const repeatAccepted = async () => {
        const before = await service.read((state) => state.groups[group.id]);
        assert.deepEqual(await Promise.all([groups.submit(group.id, followUp), groups.submit(group.id, followUp)]), [{ accepted: true }, { accepted: true }]);
        assert.deepEqual(await service.read((state) => state.groups[group.id]), before, "same-ID retries do not enqueue work or spend another attempt");
        assert.equal(fixture.requests.length, 2);
      };
      await groups.submit(group.id, followUp);
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
      assert.deepEqual(await service.read((state) => state.groups[group.id].recoveryRequests), [{ id: followUp.clientMessageId, turnId: failed.id, attempt: 1 }]);
      await repeatAccepted();
      const delivered = (await readGroupTimeline(home, group.id)).find((event) => event.kind === "coworker");
      for (const crash of ["before-append", "before-receipt"]) {
        await groups.stop();
        await service.stop();
        service = createCollaboration(options);
        await service.change((state) => {
          state.executions[delivered.executionId].groupReply.published = false;
          if (crash === "before-append") {
            delete state.groups[group.id].recoveryRequests;
            state.groups[group.id].queue.push({ id: "explicit-follow-up", text: failed.prompt, turnId: failed.id, attempt: 1 });
          }
        });
        await service.stop();
        await updateGroupTurn(home, group.id, failed.id, { speaker: { slug: "scout", status: "stopped" } });
        const events = await readGroupTimeline(home, group.id);
        // The second window also covers a pre-upgrade event lacking execution correlation.
        const { executionId, ...legacy } = delivered;
        const kept = events.filter((event) => event.id !== delivered.id);
        if (crash === "before-receipt") kept.push(legacy);
        await writeFile(path.join(home, ".groups", group.id, "timeline.jsonl"), kept.map((event) => JSON.stringify(event)).join("\n") + "\n");
        service = createCollaboration(options);
        groups = createGroupExecution({ ...groupOptions, collaboration: service });
        await groups.start();
        await service.start();
        await eventually(async () => (await service.read((state) => state.executions[executionId])).groupReply.published);
        assert.equal((await getGroup(home, group.id)).turns[0].status, "succeeded");
        const activity = await groups.activity(group.id, (scope) => service.activityEntries(scope));
        assert.equal(activity.timeline.filter((event) => event.id === delivered.id).length, 1);
        assert.equal(activity.executions.length, 0);
        assert.equal(fixture.requests.length, 2, "delivery recovery does not replay native work");
        await eventually(async () => !(await groups.status(group.id)).active);
        await repeatAccepted();
      }
      const fresh = { ...followUp, clientMessageId: "fresh-follow-up" };
      assert.deepEqual(await groups.submit(group.id, fresh), { accepted: true });
      assert.equal(await service.read((state) => state.groups[group.id].retryCounts[failed.id]), 2);
      assert.deepEqual(await service.read((state) => state.groups[group.id].recoveryRequests.at(-1)), { id: fresh.clientMessageId, turnId: failed.id, attempt: 2 });
      await eventually(async () => !(await groups.status(group.id)).active);
      await repeatAccepted();
      await assert.rejects(groups.submit(group.id, { ...followUp, clientMessageId: "over-budget" }), /follow-up limit/);
      await service.change((state) => { (state.groups[group.id].cancelledRequestIds ??= []).push(followUp.clientMessageId); });
      await assert.rejects(groups.submit(group.id, followUp), /cancelled/);
      assert.equal(await service.read((state) => state.groups[group.id].retryCounts[failed.id]), 2);
      assert.equal(fixture.requests.length, 2);
    } finally { await groups.stop(); await service.stop(); }
  });
});

test("the backend preserves semantic audiences beyond the general budget and carries the chosen response mode", async () => {
  await withHome(async (home) => {
    const members = ["scout", "editor", "ops", "care"];
    let selection;
    const fixture = nativeFixture(async ({ slug, threadId, reply }) => {
      if (slug === ".coordinator") reply.parts.push({ type: "text", text: JSON.stringify(selection.plan) });
      else {
        reply.parts.push({ type: "text", text: `Completed ${selection.id} by ${slug}.` });
        if (selection.id === "collective" && slug === "scout") fixture.held.add(threadId);
      }
    });
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5 });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, pollMs: 5,
      coworkerFor: async (slug) => ({ slug, name: slug, role: "", mission: "", model: "test/model" }),
      coordinator: async () => ({ workspaceId: "coordinator" }),
      catalogFor: async () => ({ models: [{ id: "test/model", providerId: "test", modelId: "model", variants: [], source: "local", tier: "key", toolCall: true, status: "active", label: "Test", releaseDate: "" }] }),
    });
    try {
      const group = await createGroup(home, { name: "Team", participantSlugs: members });
      await groups.start();
      // Deterministic routing results test plumbing, not model interpretation of the messages.
      for (const scenario of [
        { id: "general", text: "What should we consider?", plan: { addressedSlugs: [], speakers: members.slice(0, 3).map((slug) => ({ slug })), followUp: { slug: "scout", brief: "React" }, synthesizer: "editor" } },
        { id: "collective", text: "How are you all doing", plan: { addressedSlugs: members, speakers: members.map((slug) => ({ slug })), mode: "parallel" } },
        { id: "excluded", text: "Everyone except @scout, how are you doing?", plan: { addressedSlugs: members.slice(1), speakers: members.slice(1).map((slug) => ({ slug })), mode: "parallel" } },
        { id: "single", text: "Editor, just you: how are you doing?", plan: { addressedSlugs: ["editor"], speakers: [{ slug: "editor" }], mode: "parallel" } },
        { id: "chain", text: "Each of you, build on the previous reply in turn.", plan: { addressedSlugs: members, speakers: members.map((slug) => ({ slug })), mode: "sequential", dependsOn: [["editor", "scout"], ["ops", "editor"], ["care", "ops"]] } },
      ]) {
        selection = scenario;
        const before = fixture.requests.length;
        await groups.submit(group.id, { clientMessageId: scenario.id, text: scenario.text });
        if (scenario.id === "collective") {
          await eventually(() => fixture.requests.slice(before).filter((entry) => entry.slug !== ".coordinator").length === 4);
          assert.equal(fixture.held.size, 1, "all peers are admitted without waiting for the first reply");
          fixture.held.clear();
        }
        await eventually(async () => !(await groups.status(group.id)).active);
        const turn = (await getGroup(home, group.id)).turns.at(-1);
        const expected = scenario.plan.speakers.map((entry) => entry.slug);
        assert.equal(turn.routedBy, "facilitator");
        assert.equal(turn.status, "succeeded");
        assert.deepEqual(turn.speakers.map((entry) => entry.slug), expected);
        const requests = fixture.requests.slice(before).filter((entry) => entry.slug !== ".coordinator");
        assert.deepEqual(requests.map((entry) => entry.slug).sort(), [...expected].sort());
        for (const request of requests) {
          assert.match(request.prompt, new RegExp(`First-round mode: ${scenario.plan.mode ?? "sequential"}`));
          for (const slug of expected) assert.ok(request.prompt.includes(`(${slug}): reply`));
          assert.ok(request.prompt.includes(`(${request.slug}): reply [your step]`));
          if (scenario.plan.mode === "parallel") assert.doesNotMatch(request.prompt, /Already said in reply to this message:/);
          if (scenario.id === "chain") {
            const index = members.indexOf(request.slug);
            for (const earlier of members.slice(0, index)) assert.ok(request.prompt.includes(`Completed chain by ${earlier}.`));
            for (const later of members.slice(index)) assert.ok(!request.prompt.includes(`Completed chain by ${later}.`));
          }
        }
        assert.deepEqual((await readGroupTimeline(home, group.id)).filter((entry) => entry.turnId === turn.id && entry.kind === "coworker").map((entry) => entry.slug), expected);
        if (scenario.id === "collective") {
          const count = fixture.requests.length;
          await groups.submit(group.id, { clientMessageId: "resume-collective", text: scenario.text, turnId: turn.id });
          await eventually(async () => !(await groups.status(group.id)).active);
          assert.deepEqual((await getGroup(home, group.id)).turns.at(-1).speakers.map((entry) => entry.slug), members, "recovery does not truncate a stored collective plan");
          assert.equal(fixture.requests.length, count, "completed participants are not replayed");
        }
      }
    } finally { await groups.stop(); await service.stop(); }
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
