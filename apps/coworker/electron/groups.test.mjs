import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
