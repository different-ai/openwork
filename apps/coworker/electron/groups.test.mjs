import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  appendGroupEvent,
  archiveGroup,
  createGroup,
  getGroup,
  listGroups,
  normalizeParticipantSlugs,
  parseTimeline,
  readGroupTimeline,
  updateGroup,
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
