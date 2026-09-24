import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { marked } from "marked";
import { z } from "zod";
import { createCollaboration, nativeMessageId, withAbort } from "./collaboration.mjs";
import { nativeTurnAgent, coworkerAgent } from "./native-turns.mjs";
import { createTeamSessionRegistry } from "./team-sessions.mjs";
import { awaitNativePluginActivation } from "./turn-roles-plugin.mjs";
import { dispatchNativeTurn, nativeAdmissionRefusal } from "./native-recovery.mjs";
import { HeadlessThreadError } from "@openwork/headless-threads/v2";
import { createActivityInbox, mentionsYou, recordActivity, MAX_ACTIVITY_ITEMS, EVENT_REMINDER_LEAD_MS } from "./activity-inbox.mjs";
import { createConversationMemory } from "./conversation-memory.mjs";
import { createGroupExecution, repairGroupSelection } from "./group-execution.mjs";
import { normalizeSettings, readSettings, updateSettings } from "./settings.mjs";
import { createCoworker, getCoworker, updateCoworker } from "./coworkers.mjs";
import { createMaintenanceAdmission } from "./maintenance.mjs";
import { withInteractiveQuestionDefault } from "./collaboration-plugin.mjs";
import { createEvents, assertEventToolContext, assertEventHumanOrigin, eventToolCatalog, eventNativeSchemas } from "./events.mjs";
import { EVENT_PLUGIN } from "./event-plugin.mjs";
import { createCoworkerToolsServer } from "./coworker-tools.mjs";
import { coworkerIdentity, EVENT_CONTEXT_LIMIT, EVENT_DYNAMIC_LIMIT } from "./event-execution.mjs";
import { eventForTarget, eventInputSchema, groupEventTarget } from "../src/lib/events.ts";
import { updateAllHands, prepareAllHands, claimAllHands, readAllHands } from "./all-hands.mjs";
import { createWorker, getWorker, nextWorkerState, parseWorkerReport, prepareWorkerTurn, queueWorkerSteer, updateWorker } from "./workers.mjs";
import { connectedModelCatalog, createCoworkerThreads } from "../src/lib/threads.ts";
import { resolveDiscussionModel } from "../src/lib/model-choice.ts";
import { executionProgress } from "../src/lib/progress-activity.ts";
import { groupConversationRows, reconcileGroupActivity } from "../src/lib/group-continuity.ts";
import { describeGroupPresentation } from "../src/lib/group-presentation.ts";
import { fixtureCatalog, fixtureProvider } from "../src/lib/provider-catalog.fixture.ts";
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

function mainFunction(source, name) {
  const declaration = source.match(new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?^\\}`, "m"))?.[0];
  assert.ok(declaration, `Missing main function ${name}`);
  return declaration;
}

test("host session creation retains the caller's exact reconciliation id", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf('  "sessions.create":');
  const end = source.indexOf('  "reactions:read":', start);
  assert.ok(start > 0 && end > start);
  const requests = [];
  const model = { providerId: "fixture", modelId: "text" };
  const create = runInNewContext(`({${source.slice(start, end)}})["sessions.create"]`, {
    checkedSessionCoworker: async () => ({ workspaceId: "ws_team" }), warmCoworkerWorkspace: async () => {},
    ensurePlatformServer: async () => ({ url: "http://127.0.0.1:1" }), ownerToken: "fixture",
    ownedSessionClient: () => ({ createThread: async (input) => { requests.push(input); return { id: input.threadId }; } }),
  });
  const input = { threadId: "ses_reconcile", title: "Retain identity", model };
  assert.equal((await create({ input })).id, input.threadId);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [input]);
});

test("shared session input intents preserve classification and original native location", async () => {
  await withHome(async (home) => {
    const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const coworker = { slug: "scout", createdAt: "2026-09-11T00:00:00.000Z", workspaceId: "ws_legacy", path: path.join(home, "scout") };
    const team = { workspaceId: "ws_team", path: path.join(home, ".runtime") };
    let current = coworker;
    const file = path.join(home, "owners.json");
    const registry = createTeamSessionRegistry({ file, coworkerFor: async () => current });
    const sent = [], intents = [];
    const create = runInNewContext(`${mainFunction(source, "ownedSessionClient")}\nownedSessionClient`, {
      URL, path, teamSessions: registry, teamWorkspace: () => team, coworkerAgent, nativeRuntime: { apiContract: "native-2" },
      skillAwareClient: (options) => ({ onIntent: options.onIntent, transport: options.fetch }), sessionBinding: (owner, id) => registry.resolve(id, owner),
    });
    const options = { baseUrl: "http://127.0.0.1:1", workspaceId: coworker.workspaceId, fetch: async (url) => { sent.push(url); }, onIntent: async (intent) => { intents.push(intent); } };
    const client = create(coworker, options);
    for (const kind of ["group", "consultation", "assignment", "worker", "legacy", "private"]) for (const shared of [true, false]) {
      const binding = await registry.bind({ ...coworker, sessionId: `ses_${kind}_${shared}`, nativeWorkspaceId: shared ? team.workspaceId : coworker.workspaceId, directory: shared ? team.path : coworker.path, kind });
      const before = await readFile(file, "utf8");
      const intent = { threadId: binding.sessionId, messageId: `msg_${kind}_${shared}` };
      await client.onIntent(intent);
      assert.equal(intents.at(-1), intent);
      assert.equal(await readFile(file, "utf8"), before);
      await client.transport(`${options.baseUrl}/workspace/${coworker.workspaceId}/opencode2/api/session/${binding.sessionId}/message`, { method: "GET" });
      assert.equal(new URL(sent.at(-1)).pathname, `/workspace/${binding.nativeWorkspaceId}/opencode2/api/session/${binding.sessionId}/message`);
    }
    const before = await readFile(file, "utf8");
    await assert.rejects(client.onIntent({ threadId: "ses_unknown", messageId: "msg_unknown" }), /matching host owner/);
    current = { ...coworker, createdAt: "2026-09-12T00:00:00.000Z" };
    await assert.rejects(client.onIntent({ threadId: "ses_group_true", messageId: "msg_replaced" }), /retired or replaced/);
    assert.equal(await readFile(file, "utf8"), before);
    current = coworker;
    const creation = { threadId: "ses_created" };
    await create(coworker, options, "unassigned").onIntent(creation);
    assert.equal(intents.at(-1), creation);
    assert.deepEqual(await registry.resolve(creation.threadId, coworker), { slug: coworker.slug, createdAt: coworker.createdAt, sessionId: creation.threadId,
      workspaceId: coworker.workspaceId, nativeWorkspaceId: team.workspaceId, directory: team.path, kind: "unassigned" });
  });
});

test("shared session inventory isolates uncertain creation and unavailable reads without changing bindings", async () => {
  await withHome(async (home) => {
    const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const owner = { slug: "scout", createdAt: "2026-09-11T00:00:00.000Z", workspaceId: "ws_legacy", path: path.join(home, "scout") };
    const team = { workspaceId: "ws_team", path: path.join(home, ".runtime") };
    const file = path.join(home, "owners.json");
    const registry = createTeamSessionRegistry({ file, coworkerFor: async () => owner });
    const sessions = new Map(), errors = new Map(), reads = [];
    const failure = (id, status, code = "request_failed") => new HeadlessThreadError({ code, status, method: "GET", path: `/api/session/${id}`, message: `Unavailable ${id}` });
    for (const id of ["ses_ready", "ses_creation", "ses_unavailable", "ses_legacy"]) {
      const legacy = id === "ses_legacy";
      const binding = await registry.bind({ ...owner, sessionId: id, nativeWorkspaceId: legacy ? owner.workspaceId : team.workspaceId, directory: legacy ? owner.path : team.path, kind: legacy ? "legacy" : "private" });
      sessions.set(id, { id, location: { directory: binding.directory }, time: { created: Date.parse(owner.createdAt) + 1 } });
    }
    errors.set("ses_creation", failure("ses_creation", 404));
    errors.set("ses_unavailable", failure("ses_unavailable", 503));
    const inventory = runInNewContext(`${mainFunction(source, "ownedNativeSessions")}\nownedNativeSessions`, {
      path, teamSessions: registry, teamWorkspace: () => team, ownerToken: "fixture-owner", ensurePlatformServer: async () => ({ url: "http://127.0.0.1:1", config: { workspaces: [] } }),
      collaboration: { read: (reader) => reader({ executions: { legacy: { owner: { slug: owner.slug, threadId: "ses_legacy" }, state: "running" } } }) },
      createNativeV2Client: ({ workspaceId }) => ({ getSession: async (id) => { reads.push({ id, workspaceId }); if (errors.has(id)) throw errors.get(id); return sessions.get(id); } }),
    });
    const before = await readFile(file, "utf8");
    assert.deepEqual(Array.from(await inventory(owner), (session) => session.id), ["ses_ready", "ses_legacy"]);
    assert.ok(reads.some((read) => read.id === "ses_legacy" && read.workspaceId === owner.workspaceId));
    assert.equal(await readFile(file, "utf8"), before);
    await assert.rejects(registry.route("ses_creation", owner, async () => ({ getSession: async () => { throw errors.get("ses_creation"); } })), { status: 404 });
    errors.delete("ses_creation");
    assert.deepEqual(Array.from(await inventory(owner), (session) => session.id), ["ses_ready", "ses_creation", "ses_legacy"]);
    for (const error of [failure("ses_unavailable", 200, "invalid_response"), failure("ses_unavailable", 403), new Error("corrupt record")]) {
      errors.set("ses_unavailable", error);
      await assert.rejects(inventory(owner), (actual) => actual === error);
    }
    errors.clear();
    sessions.get("ses_ready").location.directory = owner.path;
    await assert.rejects(inventory(owner), /original host binding/);
    assert.equal(await readFile(file, "utf8"), before);
    await writeFile(file, "{");
    await assert.rejects(inventory(owner), SyntaxError);
  });
});

test("native questions get a client default without overriding explicit tool rules", () => {
  assert.deepEqual(withInteractiveQuestionDefault({}), { permissions: [{ action: "question", resource: "*", effect: "allow" }] });
  for (const config of ["*", "question", "q*"].map((action) => ({ permissions: [{ action, resource: "*", effect: "deny" }] }))) {
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

const fixtureCreatedAt = "2026-09-11T00:00:00.000Z";
const fixtureIdentity = { coworkerCreatedAt: fixtureCreatedAt };
const fixtureCoworker = async (slug) => ({ slug, name: slug, role: "", mission: "", workspaceId: `workspace_${slug}`, createdAt: fixtureCreatedAt });

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
    coworkerCreatedAt: fixtureCreatedAt,
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
        await input.beforeInput?.();
        requests.push({ slug, threadId, ...input });
        const reply = { id: `assistant_${++sequence}`, role: "assistant", parentId: input.messageId, completedAt: null, error: null, parts: [{ type: "tool", callId: `call_${sequence}` }] };
        messages.push({ id: input.messageId, role: "user", parentId: null, parts: [...(input.context ? [{ type: "text", text: input.context, synthetic: true }] : []), { type: "text", text: input.prompt }] }, reply);
        histories.set(threadId, messages);
        const answer = await onSend({ slug, threadId, input, reply });
        reply.completedAt = Date.now();
        reply.parts.push({ type: "text", text: typeof answer === "string" ? answer : slug === "editor" ? "CHECKED PUBLIC FACT" : "Original task followed up." });
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

test("shared group bootstrap preserves unresolved historical owners and validates live admission independently", async () => {
  await withHome(async (home) => {
    const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const owners = new Map(await Promise.all(["scout", "editor", "retired", "replaced"].map(async (slug) => [slug, { ...await fixtureCoworker(slug), path: path.join(home, slug) }])));
    const coworkerFor = async (slug) => {
      const owner = owners.get(slug);
      if (owner instanceof Error) throw owner;
      if (!owner) throw Object.assign(new Error("The original coworker is missing."), { code: "ENOENT" });
      return owner;
    };
    const file = path.join(home, "owners.json");
    const registry = createTeamSessionRegistry({ file, coworkerFor });
    const groups = {};
    for (const slug of ["scout", "retired", "replaced", "missing"]) {
      const group = await createGroup(home, { name: slug, participantSlugs: [slug, "editor"] });
      groups[slug] = await updateGroup(home, group.id, { participantThreadIds: { [slug]: `ses_${slug}` } });
      if (owners.has(slug)) await registry.bind({ ...owners.get(slug), sessionId: `ses_${slug}`, nativeWorkspaceId: "ws_team", directory: path.join(home, ".runtime"), kind: "group" });
    }
    await archiveGroup(home, groups.retired.id);
    owners.delete("retired");
    owners.set("replaced", { ...owners.get("replaced"), createdAt: "2026-09-12T00:00:00.000Z" });
    const first = source.indexOf("  resolveOwner:", source.indexOf("const collaboration ="));
    const validation = source.indexOf("  validateOwner:", first);
    const helper = source.match(/^async function resolveSessionOwner\([\s\S]*?^\}/m)?.[0] ?? "";
    const callbacks = runInNewContext(`${helper}\n({${source.slice(first, source.indexOf("  acceptanceTimeoutMs:", first))}${source.slice(validation, source.indexOf("  consult:", validation))}})`, {
      coworkersDir: home, getCoworker: (_directory, slug) => coworkerFor(slug), sessionBinding: (owner, id) => registry.resolve(id, owner),
      teamWorkspace: () => ({ workspaceId: "ws_team" }), coworkerAgent, events: { validateOwner: async () => {} },
    });
    const fixture = nativeFixture();
    const service = createCollaboration({ directory: home, ...callbacks, clientFor: fixture.clientFor, pollMs: 5 });
    const execution = createGroupExecution({ directory: home, collaboration: service, coworkerFor, clientFor: fixture.clientFor, pollMs: 60_000 });
    try {
      await service.change((state) => { state.owners["replaced:ses_replaced"] = { slug: "replaced", threadId: "ses_replaced", conversationId: groups.replaced.id, groupId: groups.replaced.id, kind: "group", coworkerCreatedAt: fixtureCreatedAt }; });
      const before = await readFile(file, "utf8");
      await execution.start();
      for (const slug of ["retired", "replaced", "missing"]) {
        const historical = await service.owner(slug, `ses_${slug}`);
        assert.equal(historical.kind, "group");
        assert.equal(historical.conversationId, groups[slug].id);
        assert.equal(historical.coworkerCreatedAt, slug === "replaced" ? fixtureCreatedAt : undefined);
        await assert.rejects(callbacks.validateOwner(historical), /missing|matching host owner|original session owner/);
      }
      await assert.rejects(execution.participant(groups.replaced.id, "replaced"), /matching host owner|original coworker/);
      assert.equal(await readFile(file, "utf8"), before);
      assert.equal(fixture.requests.length, 0);
      const live = await execution.participant(groups.scout.id, "scout");
      assert.equal(live.coworkerCreatedAt, fixtureCreatedAt);
      assert.equal(live.agent, coworkerAgent("scout"));
      const stale = await service.submit({ owner: await service.owner("replaced", "ses_replaced"), messageId: "msg_stale", prompt: "Do not run for a replacement" });
      const healthy = await service.submit({ owner: live, messageId: "msg_healthy", prompt: "Continue verified work" });
      await service.start();
      await eventually(async () => (await service.read((state) => state.executions[stale.id])).state === "failed" && (await service.read((state) => state.executions[healthy.id])).state === "succeeded");
      assert.deepEqual(fixture.requests.map((request) => request.threadId), [live.threadId]);
      const corruption = new Error("Corrupt coworker record");
      owners.set("scout", corruption);
      await assert.rejects(callbacks.validateOwner(live), (error) => error === corruption);
      await service.change((state) => { state.owners["missing:ses_missing"].kind = "private"; });
      await assert.rejects(execution.start(), /another conversation/);
      assert.equal(await readFile(file, "utf8"), before);
    } finally { await execution.stop(); await service.stop(); }
  });
});

async function publishFixture(home, source) {
  const executionId = source.executionId ?? source.id;
  const event = await appendGroupEvent(home, source.owner.groupId, { id: `evt_${executionId}`, executionId, kind: source.state === "succeeded" ? "coworker" : "status", slug: source.owner.slug, threadId: source.owner.threadId, text: source.result || source.error });
  return { eventId: event.id, event };
}

test("Activity Event navigation keeps shared groups and accepted run snapshots distinct", () => {
  const group = { id: "grp_shared", eventId: "event_morning" };
  const morning = { ...eventInput(), id: group.eventId, groupId: group.id, title: "Morning review" };
  const afternoon = { ...morning, id: "event_afternoon", title: "Updated afternoon review" };
  const accepted = { ...afternoon, title: "Accepted afternoon review" };
  const events = [morning, afternoon];
  const runs = [{ id: "run_afternoon", eventId: afternoon.id, event: accepted }];
  const source = { groupId: group.id, eventId: afternoon.id, runId: runs[0].id, at: 1234 };
  const target = groupEventTarget(group, events, source);
  assert.deepEqual(target, { eventId: afternoon.id, runId: runs[0].id, at: 1234 });
  assert.equal(eventForTarget(events, runs, target), accepted);
  assert.equal(eventForTarget(events, runs, { eventId: morning.id, runId: runs[0].id }), undefined);
  assert.equal(eventForTarget(events, runs, { ...target, runId: "run_missing" }), undefined);
  assert.equal(eventForTarget(events, runs, { eventId: afternoon.id }), afternoon);
  assert.deepEqual(groupEventTarget(group, events, { ...source, groupId: "grp_other" }), { eventId: morning.id });
  assert.equal(groupEventTarget({ id: group.id }, events), undefined);
  assert.deepEqual(groupEventTarget({ id: group.id }, [afternoon]), { eventId: afternoon.id });
});

test("Activity referral preflight and confirmed-veto recovery preserve offers without replay", async () => {
  const [source, main] = await Promise.all([
    readFile(new URL("../src/ui/coworker-home.tsx", import.meta.url), "utf8"),
    readFile(new URL("./main.mjs", import.meta.url), "utf8"),
  ]);
  const start = source.indexOf("    ask: async (card, recent) => {");
  const end = source.indexOf("    continueWith:", start);
  const nativeStart = main.indexOf('  "team.referralResolved":');
  const nativeEnd = main.indexOf('  "coworkers.ensureWorkspace":', nativeStart);
  assert.ok(start >= 0 && end > start && nativeStart >= 0 && nativeEnd > nativeStart);
  let allowed = false, blockAfterAsked = false, failWrite = "", dispatchMode = "accepted", newerOutcome = "", newerWrite;
  const states = new Map();
  const calls = [], writes = [], dispatched = [], shown = [];
  const card = { id: "ref_guarded", to: { slug: "editor" }, message: "Review this request", why: "Use the teammate's expertise" };
  const reset = () => {
    states.set(card.id, { id: card.id, state: "offered", at: 0 });
    calls.length = writes.length = dispatched.length = shown.length = 0;
    allowed = true; blockAfterAsked = false; failWrite = ""; dispatchMode = "accepted"; newerOutcome = ""; newerWrite = undefined;
  };
  const resolve = runInNewContext(`({${main.slice(nativeStart, nativeEnd)}})["team.referralResolved"]`, {
    coworkersDir: "fixture",
    Date: { now: () => 1000 },
    teamStates: async (directory, slug) => {
      assert.equal(directory, "fixture"); assert.equal(slug, "scout");
      return { referrals: [...states.values()].map((entry) => ({ ...entry })) };
    },
    setReferralState: async (directory, slug, id, state, { now }) => {
      assert.equal(directory, "fixture"); assert.equal(slug, "scout");
      if (failWrite === state) throw new Error("Referral write unavailable");
      states.set(id, { id, state, at: now });
      writes.push(state);
      if (state === "asked" && blockAfterAsked) allowed = false;
      return { id, state, stateAt: now };
    },
  });
  const ask = runInNewContext(`({${source.slice(start, end)}}).ask`, {
    coworker: { slug: "scout", name: "Scout", role: "Research" },
    canHandOff: () => { calls.push("preflight"); return allowed; },
    coworkerBridge: { team: { referralResolved: (slug, referralId, outcome, expectedAt) => {
      calls.push(outcome);
      return resolve({ slug, referralId, outcome, expectedAt });
    } } },
    refreshTeamStates: async () => { calls.push("refresh"); shown.push(states.get(card.id).state); },
    referralPrompt: ({ message }) => message,
    onHandOff: (slug, prompt) => {
      assert.equal(states.get(card.id).state, "asked");
      calls.push("handoff");
      if (newerOutcome) newerWrite = resolve({ slug: "scout", referralId: card.id, outcome: newerOutcome });
      if (!allowed) return false;
      dispatched.push({ slug, prompt });
      if (dispatchMode === "throw") throw new Error("Handoff confirmation unavailable");
      return dispatchMode === "unknown" ? undefined : true;
    },
  });
  reset(); allowed = false;
  await ask(card, []); await ask(card, []);
  assert.deepEqual(calls, ["preflight", "preflight"]);
  assert.equal(states.get(card.id).state, "offered");
  assert.deepEqual(writes, []); assert.deepEqual(dispatched, []);
  reset(); failWrite = "asked";
  await assert.rejects(ask(card, []), /Referral write unavailable/);
  assert.deepEqual(calls, ["preflight", "asked"]);
  assert.equal(states.get(card.id).state, "offered");
  assert.deepEqual(dispatched, []);
  reset(); blockAfterAsked = true;
  await ask(card, []);
  assert.deepEqual(calls, ["preflight", "asked", "handoff", "offered", "refresh"]);
  assert.deepEqual(writes, ["asked", "offered"]);
  assert.deepEqual(shown, ["offered"]);
  assert.equal(states.get(card.id).state, "offered");
  await Promise.resolve(); assert.deepEqual(dispatched, []);
  allowed = true; blockAfterAsked = false; calls.length = 0;
  await Promise.resolve(); assert.deepEqual(dispatched, []);
  await ask(card, []);
  assert.deepEqual(calls, ["preflight", "asked", "handoff", "refresh"]);
  assert.equal(states.get(card.id).state, "asked");
  assert.deepEqual(dispatched, [{ slug: "editor", prompt: card.message }]);
  for (const mode of ["throw", "unknown"]) {
    reset(); dispatchMode = mode;
    if (mode === "throw") await assert.rejects(ask(card, []), /Handoff confirmation unavailable/);
    else await ask(card, []);
    assert.deepEqual(writes, ["asked"]);
    assert.deepEqual(shown, ["asked"]);
    await Promise.resolve(); assert.equal(dispatched.length, 1);
  }
  reset(); blockAfterAsked = true; failWrite = "offered";
  await assert.rejects(ask(card, []), /Referral write unavailable/);
  assert.deepEqual(writes, ["asked"]);
  assert.deepEqual(shown, ["asked"]);
  assert.deepEqual(dispatched, []);
  for (const outcome of ["continued", "asked"]) {
    reset(); blockAfterAsked = true; newerOutcome = outcome;
    await assert.rejects(ask(card, []), /REFERRAL_CONFLICT/);
    await newerWrite;
    assert.deepEqual(writes, ["asked", outcome]);
    assert.equal(states.get(card.id).state, outcome);
    assert.equal(states.get(card.id).at, 1001);
    assert.deepEqual(shown, [outcome]);
    assert.deepEqual(dispatched, []);
  }
  await assert.rejects(resolve({ slug: "scout", referralId: card.id, outcome: "offered" }), /exact asked receipt/);
});

test("Activity mentions require standalone @you in visible prose", () => {
  for (const value of ["@you", "A decision, @YOU?", "**@You**, choose one.", "(@you)", "Question:@you!", "Hello,@you", "- @you: which option?", "[ask @you](https://example.test)", "```js\n@you\n```\n\nOutside: @you."]) assert.equal(mentionsYou(value), true, value);
  for (const value of ["you", "@yourself", "@you-two", "@you_two", "@you2", "@youé", "@@you", "name@you", "person@you.test", "@you.test", "https://example.test/@you", "https://example.test/?ask=@you", "www.example.test/@you", "[source](https://example.test/@you)", "<https://example.test/@you>", "`@you`", "``literal ` @you``", "```js\n@you\n```", "~~~\n@you\n~~~", "```\n@you", "    @you", "> @you", "> Quoted person\n@you", "> > @you", "**name**@you", "@you**more**", "\\@you"]) assert.equal(mentionsYou(value), false, value);
});

test("Activity parsing failures never fail private completion or group publication", async (t) => {
  await withHome(async (home) => {
    const parser = t.mock.method(marked, "lexer", () => { throw new Error("Unusual Markdown"); });
    let service;
    let groups;
    let publications = 0;
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (!input.prompt.startsWith("Continue") && input.prompt.includes("Ask the editor once")) {
        const trusted = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
        await service.request(trusted, "consultation", { to: "editor", question: "Check the fact" }, fixtureIdentity);
      }
      return "@you, review the result.";
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      consult: (task) => groups.consultation(task),
      publish: (task) => { publications++; return publishFixture(home, task); },
      publishExecution: (entry) => { publications++; return publishFixture(home, entry); },
    });
    groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, coworkerFor: fixtureCoworker, coordinator: async () => ({}), catalogFor: async () => ({ models: [] }), pollMs: 5 });
    try {
      const privateReply = await service.submit({ owner: { ...fixtureIdentity, slug: "scout", threadId: "private-parser", conversationId: "private-parser", kind: "private" }, prompt: "A normal private reply" });
      await eventually(async () => (await service.read((state) => state.executions[privateReply.id])).state === "succeeded");
      const group = await createGroup(home, { name: "Parser check", participantSlugs: ["scout", "editor"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "parser-group", text: "@scout Ask the editor once" });
      await eventually(async () => (await service.listActivity()).length === 4 && !(await groups.status(group.id)).active);
      assert.ok(parser.mock.callCount() >= 4, "each capture actually encountered the parser failure");
      assert.ok((await service.listActivity()).every((item) => item.kind === "reply"), "classification falls back without failing the source");
      assert.equal(publications, 2, "consultation and group continuation publish once, without notification retries");
      assert.deepEqual(fixture.aborted, []);
      assert.ok(await service.read((state) => Object.values(state.executions).every((entry) => entry.state === "succeeded" && !entry.publicationAttempts && !entry.publicationFailed && (!entry.groupReply || entry.groupReply.published))));
      const before = await service.listActivity();
      await service.change((state) => {
        const source = { ...state.executions[privateReply.id], activityRecorded: false };
        recordActivity(state, source, { get text() { throw new Error("Unexpected projection input"); } });
        assert.equal(source.state, "succeeded");
      });
      assert.deepEqual(await service.listActivity(), before, "a recording failure leaves the index intact");
    } finally { await groups.stop(); await service.stop(); parser.mock.restore(); }
  });
});

test("turn submission preserves definitive refusal and generation checks without erasing uncertainty", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const prefix = '  "turns.send": ';
  const start = source.indexOf(prefix) + prefix.length;
  const end = source.indexOf('\n  },\n  "turns.cancel"', start);
  assert.ok(start >= prefix.length && end > start);
  for (const phase of ["prepared", "attempted", undefined]) {
    for (const state of ["failed", "running", "cancelled"]) for (const status of [undefined, 400, 403, 422, 500]) {
      const admissionFailure = status === undefined ? null : nativeAdmissionRefusal(new HeadlessThreadError({ code: "request_failed", method: "POST", path: "/session/ses_fixture/prompt", status, message: "Fixture rejection" }));
      const entry = { id: "exec_fixture", messageId: "msg_fixture", prompt: "Hello", nativeAdmission: phase, state, error: "Fixture rejection", admissionFailure };
      const send = runInNewContext(`(${source.slice(start, end)}\n})`, {
        privateTurnIntents: new Map(), privateOwner: async () => ({}), assertExpectedReadiness: () => {}, collaboration: {
          submit: async () => entry,
          acceptance: async () => { throw new Error("Admission unconfirmed"); },
          read: async (read) => read({ executions: { [entry.id]: entry } }),
        },
      });
      const result = send({ slug: "fixture", threadId: "ses_fixture", messageId: "msg_fixture", prompt: "Hello" });
      if ((phase === "prepared" || admissionFailure) && state !== "running") assert.deepEqual(JSON.parse(JSON.stringify(await result)), {
        rejected: true, messageId: "msg_fixture", notSubmitted: phase === "prepared", code: admissionFailure?.code ?? "not_submitted", ...(admissionFailure ? { status } : {}), error: "Fixture rejection",
      });
      else await assert.rejects(result, /Admission unconfirmed/);
    }
  }
  assert.equal(nativeAdmissionRefusal(new HeadlessThreadError({ code: "request_failed", method: "GET", path: "/session/ses_fixture/message", status: 403, message: "Observation refused" })), null);
  const privateTurnIntents = new Map();
  const release = Promise.withResolvers();
  let ownershipCalls = 0;
  const send = runInNewContext(`(${source.slice(start, end)}\n})`, {
    privateTurnIntents, privateOwner: async () => { ownershipCalls++; await release.promise; throw new Error("Owner rejected"); },
  });
  const input = { slug: "fixture", threadId: "ses_fixture", prompt: "Hello" };
  const pending = Array.from({ length: 64 }, (_, index) => send({ ...input, messageId: `msg_${index}` }).then((result) => { assert.equal(result.rejected, true); assert.equal(result.notSubmitted, true); }));
  await assert.rejects(send({ ...input, messageId: "msg_0" }), /already pending/);
  await assert.rejects(send({ ...input, messageId: "msg_overflow" }), /already pending/);
  assert.equal(ownershipCalls, 64);
  release.resolve(); await Promise.all(pending);
  assert.equal(privateTurnIntents.size, 0);
  let generation = "old";
  let submissions = 0;
  const ownership = Promise.withResolvers();
  const expectedSource = source.slice(source.indexOf("function assertExpectedReadiness("), source.indexOf("function invalidateWorkspaceReadiness("));
  const assertExpectedReadiness = runInNewContext(`${expectedSource}\nassertExpectedReadiness`, { readinessKey: () => generation, workspaceRevision: () => 0, pendingWorkspaceReadinessChanges: () => [], serverHandle: { managedOpencodeV2: { isAlive: () => true } } });
  const receipt = { threadId: "ses_fixture", messageId: "msg_fixture", acceptedAt: 1, messageCountBefore: 0 };
  const acceptedEntry = { id: "exec_fixture", prompt: "Hello", acceptance: receipt };
  const guardedSend = runInNewContext(`(${source.slice(start, end)}\n})`, {
    privateTurnIntents: new Map(), assertExpectedReadiness,
    privateOwner: async () => { await ownership.promise; return { workspaceId: "ws_fixture", coworkerCreatedAt: fixtureCreatedAt }; },
    collaboration: { submit: async () => { submissions++; return acceptedEntry; }, acceptance: async () => { throw new Error("Late acknowledgement"); }, read: async (read) => read({ executions: { exec_fixture: acceptedEntry } }) },
  });
  const guardedInput = { slug: "fixture", threadId: "ses_fixture", messageId: "msg_fixture", prompt: "Hello", expectedReadiness: { readinessKey: "old", workspaceId: "ws_fixture", createdAt: fixtureCreatedAt } };
  const stale = guardedSend(guardedInput);
  generation = "replacement";
  ownership.resolve();
  assert.equal((await stale).code, "readiness_changed");
  assert.equal(submissions, 0);
  assert.equal((await guardedSend({ ...guardedInput, expectedReadiness: { ...guardedInput.expectedReadiness, readinessKey: generation } })).messageId, receipt.messageId);
  assert.equal(submissions, 1);
  await withHome(async (home) => {
    const created = await createCoworker(home, { name: "Fixture", role: "Test" });
    const coworker = await updateCoworker(home, created.slug, { workspaceId: "ws_fixture", model: "fixture/model", modelVariant: "low", modelChosenBy: "app", useAppModelDefaults: true });
    const otherCreated = await createCoworker(home, { name: "Neighbor", role: "Test" });
    const other = await updateCoworker(home, otherCreated.slug, { workspaceId: "ws_neighbor", model: coworker.model });
    const settingsPath = path.join(home, "settings.json");
    await updateSettings(settingsPath, { modelDefaults: { conversation: { model: coworker.model, modelVariant: "low" } } });
    const handle = { url: "http://127.0.0.1:8790", managedOpencodeV2: { pid: 1234, isAlive: () => true } };
    const frame = {};
    const event = { sender: { mainFrame: frame }, senderFrame: frame };
    let invoke, readGate, gate, syncGate, warmGate, syncOutcome = { status: "noop" }, failSave = false, notifications = 0, serverCalls = 0;
    const save = async (write) => {
      if (gate) { gate.entered.resolve(); await gate.release.promise; }
      const result = await write();
      if (failSave) throw new Error("Save acknowledgement unavailable");
      return result;
    };
    const context = {
      Error, AbortSignal, withAbort, serverHandle: handle, denSession: null, coworkersDir: home, settingsPath,
      teamWorkspace: () => ({ path: home, workspaceId: coworker.workspaceId, name: "Team" }), installedTeamRevision: "fixture-team", awaitNativePluginActivation, nativeRuntime: {},
      toolsRegistered: new Set([coworker.workspaceId, other.workspaceId]), ensureToolsServer: async () => ({}), installNativeCoworkerPlugins: async () => {}, prepareNativeTurnRoles: async () => {},
      nativeWorkspaceRequest: async (_handle, _workspaceId, _method, route) => {
        if (route === "/api/plugin/await-activation" && warmGate) { warmGate.entered.resolve(); await warmGate.release.promise; }
        if (route === "/api/agent/build") return { data: { permissions: [] } };
        if (route === "/api/plugin") return { data: ["collaboration", "computer", "browser", "group-documents", "events", "abilities", "turn-roles", "progress-summary", "auto-memory"].map((id) => ({ id: `coworker.${id}`, state: { status: "active" } })) };
      },
      denSessionHandoff: Promise.resolve(), storedSkillSession: null, appliedSkillSession: null,
      denAccountHandoff: Promise.resolve(), denAccountGeneration: 0, denAccountReady: false,
      getCoworker: async (...args) => {
        if (readGate && args[1] === coworker.slug) { readGate.entered.resolve(); await readGate.release.promise; }
        return getCoworker(...args);
      },
      readSettings, updateCoworker: (...args) => save(() => updateCoworker(...args)), updateSettings: (...args) => save(() => updateSettings(...args)),
      privateOwner: async () => ({}), progressSummaries: { configure() {} }, conversationMemory: { configure() {} },
      ensurePlatformServer: async () => { serverCalls++; return handle; }, loadOrCreateTokens: async () => ({ hostToken: "fixture-host" }),
      fetchJson: async () => {
        if (syncGate) { syncGate.entered.resolve(); await syncGate.release.promise; }
        if (syncOutcome instanceof Error) throw syncOutcome;
        return syncOutcome;
      },
      mainWindow: { isDestroyed: () => false, webContents: { send: () => { notifications++; } } }, runtimeInfo: () => ({}),
      maintenanceAdmission: createMaintenanceAdmission(), resetInProgress: false,
      ipcMain: { handle: (_name, callback) => { invoke = (command, payload = {}) => callback(event, { command, payload }); } },
    };
    const handlers = [["coworkers.update", "abilities.catalog"], ["settings.update", "shell.openExternal"], ["den.providers.sync", "voice.status"]]
      .map(([first, next]) => source.slice(source.indexOf(`  "${first}":`), source.indexOf(`  "${next}":`))).join("\n");
    const readiness = runInNewContext(`${source.slice(source.indexOf("const warmedCoworkerWorkspaces ="), source.indexOf("\n// ---------------------------------------------------------------------------", source.indexOf("function warmCoworkerWorkspace(")))}
      ${source.slice(source.indexOf("function queueDenSessionHandoff("), source.indexOf("async function clearDenSession("))}
      const commands = {${handlers}};
      ${source.slice(source.indexOf("function registerIpc()"), source.indexOf("function installApplicationMenu()"))}
      registerIpc();
      ({ readinessKey, workspaceRevision, assertExpectedReadiness, workspaceReadinessChanges, workspaceReadinessRevisions, warmedCoworkerWorkspaces, warmedCoworkerScopes, warmCoworkerWorkspace });`, context);
    const owner = { slug: coworker.slug, workspaceId: coworker.workspaceId, coworkerCreatedAt: coworker.createdAt };
    const otherOwner = { slug: other.slug, workspaceId: other.workspaceId, coworkerCreatedAt: other.createdAt };
    const prepared = { readinessKey: readiness.readinessKey(), workspaceId: coworker.workspaceId, createdAt: coworker.createdAt, workspaceRevision: 0 };
    const otherPrepared = { ...prepared, workspaceId: other.workspaceId, createdAt: other.createdAt };
    readiness.warmedCoworkerWorkspaces.add(coworker.workspaceId);
    readiness.warmedCoworkerWorkspaces.add(other.workspaceId);
    readiness.warmedCoworkerScopes.set(other.workspaceId, "neighbor-prepared");
    for (const [command, payload] of [
      ["den.providers.sync", {}],
      ["coworkers.update", { slug: coworker.slug, patch: { model: " fixture/model ", modelVariant: " low ", modelSelectionPreferences: coworker.modelSelectionPreferences } }],
      ["settings.update", { modelDefaults: { conversation: { model: " fixture/model ", modelVariant: " low " } } }],
    ]) {
      assert.equal((await invoke(command, payload)).ok, true);
      assert.equal(readiness.readinessKey(), prepared.readinessKey, `${command} preserves a completed no-op's prepared stamp`);
      assert.doesNotThrow(() => readiness.assertExpectedReadiness(prepared, owner));
    }
    assert.equal(serverCalls, 0, "the direct no-session handler does not touch the runtime");
    assert.equal(notifications, 0);
    assert.equal(readiness.warmedCoworkerWorkspaces.has(coworker.workspaceId), true);
    const hookStart = source.indexOf("  validateAdmission:", source.indexOf("const collaboration = createCollaboration({"));
    const hookEnd = source.indexOf("\n  directory:", hookStart);
    assert.ok(hookStart > 0 && hookEnd > hookStart);
    const validateAdmission = runInNewContext(`({${source.slice(hookStart, hookEnd)}}).validateAdmission`, { assertExpectedReadiness: readiness.assertExpectedReadiness });
    const nativeWrites = [];
    const admitDuringLookup = (scope, expectedReadiness) => {
      const threadId = `ses_lookup_${scope.slug}`;
      const entry = { owner: { ...scope, threadId, conversationId: threadId, kind: "private" }, workspaceId: scope.workspaceId, coworkerCreatedAt: scope.coworkerCreatedAt,
        expectedReadiness, messageId: `msg_lookup_${scope.slug}`, prompt: "Hello", agent: "build", nativeAdmission: "prepared" };
      return dispatchNativeTurn({
        client: {
          getThreadSnapshot: async () => ({ threadId, messages: [], native: { engine: "v2", pendingInputIds: [], turnOutcomes: {} } }),
          sendTurn: async (_threadId, input) => { await input.beforeInput(); nativeWrites.push(scope.slug); return { threadId, messageId: input.messageId }; },
        },
        threadId, turn: entry, validateAdmission: () => validateAdmission(entry), markAttempted: async () => {},
      });
    };
    readGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    const initialChange = invoke("coworkers.update", { slug: coworker.slug, patch: { model: coworker.model } });
    try {
      await readGate.entered.promise;
      const pendingScope = readiness.workspaceReadinessChanges.values().next().value;
      assert.equal(pendingScope.slug, coworker.slug);
      assert.equal(pendingScope.workspaceId, null, "the initial coworker read has not resolved the workspace yet");
      await assert.rejects(admitDuringLookup(owner, prepared), { code: "readiness_changed", inputNotSent: true });
      assert.deepEqual(nativeWrites, [], "the production admission hook rejects before native input is written");
      await admitDuringLookup(otherOwner, otherPrepared);
      assert.deepEqual(nativeWrites, [other.slug], "the pending lookup does not fence an unrelated coworker");
    } finally { readGate.release.resolve(); await initialChange; readGate = null; }
    assert.equal((await initialChange).ok, true);
    assert.equal(readiness.readinessKey(), prepared.readinessKey);
    assert.doesNotThrow(() => validateAdmission({ owner, workspaceId: owner.workspaceId, coworkerCreatedAt: owner.coworkerCreatedAt, expectedReadiness: prepared }));
    gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    let changing, changed, posts = 0, attempts = 0;
    try {
      await assert.rejects(dispatchNativeTurn({
        client: {
          getThreadSnapshot: async () => ({ threadId: "ses_fenced", messages: [], native: { engine: "v2", pendingInputIds: [], turnOutcomes: {} } }),
          sendTurn: async (_threadId, input) => { await input.beforeInput(); posts++; },
        },
        threadId: "ses_fenced", turn: { messageId: "msg_fenced", prompt: "Hello", agent: "build", nativeAdmission: "prepared" },
        validateAdmission: () => readiness.assertExpectedReadiness(prepared, owner),
        markAttempted: async () => {
          attempts++;
          changing = invoke("coworkers.update", { slug: coworker.slug, patch: { model: "fixture/replacement" } });
          await gate.entered.promise;
          assert.equal((await invoke("den.providers.sync")).ok, true);
          assert.equal(readiness.readinessKey(), prepared.readinessKey);
          assert.equal(readiness.workspaceReadinessChanges.size, 1, "a completed no-op cannot release another operation's fence");
          assert.doesNotThrow(() => readiness.assertExpectedReadiness(otherPrepared, otherOwner), "another coworker's pending save cannot fence this workspace");
        },
      }), { code: "readiness_changed", inputNotSent: true });
    } finally { gate.release.resolve(); changed = await changing; gate = null; }
    assert.equal(changed.ok, true);
    assert.equal(attempts, 1);
    assert.equal(posts, 0);
    assert.throws(() => readiness.assertExpectedReadiness(prepared, owner), { code: "readiness_changed" });
    assert.equal(readiness.readinessKey(), prepared.readinessKey, "a coworker-only change preserves the global runtime stamp");
    assert.equal(readiness.warmedCoworkerWorkspaces.has(coworker.workspaceId), true, "model selection changes retain native preparation");
    assert.equal(readiness.warmedCoworkerWorkspaces.has(other.workspaceId), true);
    assert.equal(readiness.warmedCoworkerScopes.get(other.workspaceId), "neighbor-prepared");
    assert.doesNotThrow(() => readiness.assertExpectedReadiness(otherPrepared, otherOwner));
    for (const [command, payload] of [
      ["settings.update", { modelDefaults: { conversation: { modelVariant: "high" } } }],
      ["coworkers.update", { slug: coworker.slug, patch: { model: "fixture/replacement", modelChosenBy: "person" } }],
    ]) {
      const before = JSON.stringify([readiness.readinessKey(), readiness.workspaceRevision(coworker.workspaceId, coworker.slug)]);
      assert.equal((await invoke(command, payload)).ok, true);
      assert.notEqual(JSON.stringify([readiness.readinessKey(), readiness.workspaceRevision(coworker.workspaceId, coworker.slug)]), before, "saved effective changes still invalidate readiness");
      if (command === "settings.update") {
        assert.notEqual(readiness.readinessKey(), otherPrepared.readinessKey);
        assert.equal(readiness.warmedCoworkerWorkspaces.size, 0, "app defaults still invalidate all warm scopes");
      }
    }
    failSave = true;
    const beforeFailure = readiness.workspaceRevision(coworker.workspaceId, coworker.slug);
    assert.equal((await invoke("coworkers.update", { slug: coworker.slug, patch: { modelVariant: "high" } })).ok, false);
    assert.notEqual(readiness.workspaceRevision(coworker.workspaceId, coworker.slug), beforeFailure);
    failSave = false;
    context.denSession = { orgId: "fixture" };
    context.denAccountReady = true;
    const nativeNoChange = { fingerprintChanged: false, providerStateChanged: false, envUpserts: 0, envDeletes: 0,
      cleanupChanged: false, cleanupRuntimeChanged: false, fileChanged: false, reloadDeferred: false, nativeReloadAttempted: false, nativeReloadPending: false };
    syncOutcome = { status: "noop", detail: nativeNoChange };
    syncGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    const signedInStamp = { ...prepared, readinessKey: readiness.readinessKey(), workspaceRevision: readiness.workspaceRevision(coworker.workspaceId, coworker.slug) };
    const otherSignedInStamp = { ...otherPrepared, readinessKey: readiness.readinessKey(), workspaceRevision: readiness.workspaceRevision(other.workspaceId) };
    const beforeNotifications = notifications;
    let refreshing, refreshed;
    try {
      refreshing = invoke("den.providers.sync");
      await syncGate.entered.promise;
      assert.equal(readiness.readinessKey(), signedInStamp.readinessKey);
      assert.throws(() => readiness.assertExpectedReadiness(signedInStamp, owner), { code: "readiness_changed" });
      assert.throws(() => readiness.assertExpectedReadiness(otherSignedInStamp, otherOwner), { code: "readiness_changed" }, "a pending global refresh fences every workspace");
    } finally { syncGate.release.resolve(); refreshed = await refreshing; syncGate = null; }
    assert.equal(refreshed.ok, true);
    assert.equal(readiness.readinessKey(), signedInStamp.readinessKey);
    assert.doesNotThrow(() => readiness.assertExpectedReadiness(signedInStamp, owner));
    assert.equal(notifications, beforeNotifications);
    for (const outcome of [
      { status: "noop" }, { status: "noop", readinessUnchanged: true }, { status: "noop", detail: { nativeReloadAttempted: false } },
      ...["no_session", "applied", "failed", "unknown"].map((status) => ({ status, detail: nativeNoChange })),
      ...Object.entries(nativeNoChange).map(([field, value]) => ({ status: "noop", detail: { ...nativeNoChange, [field]: value === false ? true : 1 } })),
      new Error("Refresh unconfirmed"),
    ]) {
      syncOutcome = outcome;
      const before = readiness.readinessKey();
      assert.equal((await invoke("den.providers.sync")).ok, !(outcome instanceof Error));
      assert.notEqual(readiness.readinessKey(), before, "only a complete successful native no-change receipt preserves readiness");
    }
    assert.equal(readiness.workspaceReadinessChanges.size, 0);
    warmGate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
    const staleWarmup = readiness.warmCoworkerWorkspace(await getCoworker(home, coworker.slug));
    const staleResult = assert.rejects(staleWarmup, /changed during workspace preparation/);
    await warmGate.entered.promise;
    assert.equal((await invoke("settings.update", { modelDefaults: { conversation: { model: "fixture/after-warm" } } })).ok, true);
    warmGate.release.resolve();
    await staleResult;
    warmGate = null;
    assert.equal(readiness.warmedCoworkerWorkspaces.has(coworker.workspaceId), false, "a stale warm completion cannot restore Ready");
    await readiness.warmCoworkerWorkspace(await getCoworker(home, coworker.slug));
    assert.equal(readiness.warmedCoworkerWorkspaces.has(coworker.workspaceId), true, "a failed warmup can prepare the current scope again");
    const currentGeneration = readiness.readinessKey();
    assert.equal((await invoke("coworkers.update", { slug: "missing", patch: { model: "fixture/model" } })).ok, false);
    assert.equal(readiness.readinessKey(), currentGeneration, "an unresolved coworker save is not a global model change");
    assert.equal(readiness.warmedCoworkerWorkspaces.has(coworker.workspaceId), true);
  });
  const observed = await dispatchNativeTurn({
    client: { getThreadSnapshot: async () => ({ threadId: "ses_fixture", messages: [{ id: "msg_fixture", role: "user" }], native: { engine: "v2", pendingInputIds: [], turnOutcomes: {} } }), sendTurn: async () => assert.fail("Observed input must not be replayed") },
    threadId: "ses_fixture", turn: { messageId: "msg_fixture", nativeAdmission: "prepared" },
    markAttempted: async (receipt) => assert.equal(receipt.observed, true),
  });
  assert.equal(observed.alreadyPresent, true);
  let marks = 0, boundaries = 0, userPosts = 0;
  await assert.rejects(dispatchNativeTurn({
    client: {
      getThreadSnapshot: async () => ({ threadId: "ses_pair", messages: [], native: { engine: "v2", pendingInputIds: [], turnOutcomes: {} } }),
      sendTurn: async (_threadId, input) => { await input.beforeInput(); await input.beforeInput(); userPosts++; },
    },
    threadId: "ses_pair", turn: { messageId: "msg_pair", prompt: "Hello", context: "Reference", agent: "build", nativeAdmission: "prepared" },
    markAttempted: async () => { marks++; },
    validateAdmission: () => { if (++boundaries === 2) throw Object.assign(new Error("Configuration changed after context"), { code: "readiness_changed" }); },
  }), { code: "readiness_changed", inputNotSent: false });
  assert.equal(marks, 1);
  assert.equal(boundaries, 2);
  assert.equal(userPosts, 0);
  for (const mode of ["refused", "changed", "changed-after-marker"]) await withHome(async (home) => {
    const fixture = nativeFixture();
    let posts = 0;
    let validations = 0;
    const service = createCollaboration({ directory: home, pollMs: 5,
      validateAdmission: () => { validations++; if (mode === "changed" || (mode === "changed-after-marker" && validations === 2)) throw Object.assign(new Error("Configuration changed"), { code: "readiness_changed" }); },
      clientFor: async (slug) => {
        const client = await fixture.clientFor(slug);
        return { ...client,
          getThreadSnapshot: async (...args) => ({ ...await client.getThreadSnapshot(...args), native: { engine: "v2", pendingInputIds: [], turnOutcomes: {} } }),
          sendTurn: async (_threadId, input) => { await input.beforeInput(); posts++; throw new HeadlessThreadError({ code: "request_failed", method: "POST", path: "/session/ses_refused/prompt", status: 403, message: "Native policy refused input" }); },
          abortThread: async () => { throw new Error("Fixture cleanup unavailable"); },
        };
      },
    });
    try {
      const owner = { slug: "scout", threadId: "ses_refused", conversationId: "ses_refused", kind: "private" };
      const entry = await service.submit({ owner, messageId: "msg_refused", prompt: "Hello", track: true });
      await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "failed");
      const recorded = await service.read((state) => state.executions[entry.id]);
      assert.equal(recorded.nativeAdmission, mode === "changed" ? "prepared" : "attempted");
      if (mode !== "refused") assert.equal(recorded.admissionFailure.notSubmitted, true);
      assert.equal(recorded.admissionFailure.code, mode === "refused" ? "request_failed" : "readiness_changed");
      assert.equal((await service.activityEntries(owner))[0].admission.refusal.code, recorded.admissionFailure.code);
      assert.equal(posts, mode === "refused" ? 1 : 0);
      if (mode === "refused") {
        await assert.rejects(service.submit({ owner, messageId: "msg_next", prompt: "Do not send yet", track: true }), /earlier native admission is unresolved/);
        assert.equal(posts, 1);
      }
    } finally { await service.stop(); }
  });
});

test("foreground submission wakes dispatch without waiting for the periodic tick", async (t) => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
    const setupTimeoutMs = Number(source.match(/const collaboration = createCollaboration\(\{[\s\S]*?setupTimeoutMs: ([\d_]+)/)?.[1].replaceAll("_", ""));
    assert.equal(setupTimeoutMs, 120_000);
    const coldClient = source.slice(source.indexOf("async function collaborationClient("), source.indexOf("async function collaborationCleanupClient("));
    assert.match(coldClient, /registerCoworkerTools\(coworker, 120_000\)/);
    const entered = Promise.withResolvers();
    const prepared = Promise.withResolvers();
    let setupSignal;
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const clock = t.mock.method(AbortSignal, "timeout", (ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("Fixture deadline")), ms).unref?.();
      return controller.signal;
    });
    const service = createCollaboration({ directory: home, setupTimeoutMs, pollMs: 60_000,
      clientFor: async (slug, options) => { setupSignal = options.signal; entered.resolve(); await withAbort(prepared.promise, options.signal); return fixture.clientFor(slug); },
    });
    try {
      await service.start();
      const input = { owner: { ...fixtureIdentity, slug: "scout", workspaceId: "workspace_scout", threadId: "ses_foreground", conversationId: "ses_foreground", kind: "private" }, messageId: "msg_foreground", prompt: "Hello", track: true };
      const [first, duplicate] = await Promise.all([service.submit(input), service.submit(input)]);
      assert.equal(first.id, duplicate.id);
      t.mock.timers.tick(0);
      await entered.promise;
      t.mock.timers.tick(45_000);
      assert.equal(setupSignal.aborted, false);
      assert.equal(fixture.requests.length, 0);
      assert.equal((await service.activityEntries(input.owner))[0].admission.inFlight, "preparing");
      const readActivity = runInNewContext(`${source.slice(source.indexOf("async function readCollaborationActivity("), source.indexOf("function workerKey("))}\nreadCollaborationActivity`, {
        serverHandle: { url: "http://127.0.0.1:8790", managedOpencodeV2: { isAlive: () => true } }, collaboration: service, coworkersDir: home, ownerToken: "fixture", AbortSignal,
        getCoworker: (_directory, slug) => fixtureCoworker(slug), PROGRESS_LIMITS: { maxActivityExecutions: 16, activityReadTimeoutMs: 1000 },
        readExecutionActivity: async () => assert.fail("host preparation does not require a native input to exist"), progressSummaries: { noteFor: () => null },
      });
      const preparing = (await readActivity(input.owner))[0];
      assert.equal(preparing.available, true);
      assert.equal(preparing.nativeStatus, "unknown");
      assert.equal(executionProgress(preparing).status, "preparing");
      prepared.resolve();
      clock.mock.restore();
      t.mock.timers.reset();
      await eventually(() => fixture.requests.length === 1);
      const acceptance = await service.acceptance(first.id);
      assert.equal(acceptance.messageId, input.messageId);
      assert.equal(fixture.requests.length, 1);
      assert.deepEqual(fixture.aborted, []);
    } finally { prepared.resolve(); clock.mock.restore(); t.mock.timers.reset(); await service.stop(); }
  });
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const start = source.indexOf('  "turns.send": ');
  const end = source.indexOf('  "templates.sync": ', start);
  assert.ok(start > 0 && end > start);
  for (const gate of ["ownership", "submit", "commit", "before-send"]) await withHome(async (home) => {
    const fixture = nativeFixture();
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5 });
    const owner = { slug: "scout", threadId: "ses_fenced", conversationId: "ses_fenced", kind: "private" };
    const input = { slug: owner.slug, threadId: owner.threadId, messageId: "msg_fenced", prompt: "Hello", kind: "discussion" };
    await service.registerOwner(owner);
    const release = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const privateTurnIntents = new Map();
    let ownershipCalls = 0;
    const commands = runInNewContext(`({${source.slice(start, end)}})`, {
      privateTurnIntents, assertExpectedReadiness: () => {},
      privateOwner: async (slug, threadId, kind) => {
        ownershipCalls++;
        if (gate === "ownership" && ownershipCalls === 1) { entered.resolve(); await release.promise; }
        if (threadId === "ses_forbidden") throw new Error("Foreign native scope");
        return service.registerOwner({ slug, threadId, conversationId: threadId, kind });
      },
      collaboration: { ...service, submit: async (...args) => {
        if (gate === "submit") { entered.resolve(); await release.promise; }
        return service.submit(...args);
      } },
    });
    let blocking;
    try {
      if (gate === "before-send") {
        await service.updateThread(owner.slug, owner.threadId, { pending: null, next: [] }, { pending: { messageId: input.messageId, prompt: input.prompt, startedAt: 1, stoppedAt: null }, next: [] });
        assert.equal((await commands["turns.cancel"](input)).ok, true);
      }
      const sending = assert.rejects(commands["turns.send"](input), /Stopped/);
      if (gate === "commit") {
        blocking = service.change(async () => { entered.resolve(); await release.promise; });
      }
      if (gate !== "before-send") {
        await entered.promise;
        const stopping = commands["turns.cancel"](input);
        assert.equal(privateTurnIntents.values().next().value.cancelled, true);
        release.resolve();
        assert.equal((await stopping).ok, true);
      }
      await sending;
      assert.ok(ownershipCalls >= 2);
      assert.equal(privateTurnIntents.size, 0);
      assert.equal(fixture.requests.length, 0);
      const cancelled = await service.read((state) => Object.values(state.executions).find((entry) => entry.messageId === input.messageId));
      assert.equal(cancelled.state, "cancelled");
      assert.equal(cancelled.nativeAdmission, "attempted");
      assert.ok(cancelled.nativeStoppedAt);
      await assert.rejects(commands["turns.send"](input), /Stopped/);
      assert.equal(fixture.requests.length, 0);
      const others = [{ ...input, messageId: "msg_other" }, { ...input, threadId: "ses_other" }];
      await Promise.all(others.map((next) => commands["turns.send"](next)));
      assert.deepEqual(fixture.requests.map((request) => [request.threadId, request.messageId]).sort(), others.map((request) => [request.threadId, request.messageId]).sort());
      assert.deepEqual(fixture.aborted, []);
      await assert.rejects(commands["turns.cancel"]({ ...input, messageId: "msg_unknown" }), /No matching message/);
      assert.equal((await commands["turns.send"]({ ...input, threadId: "ses_forbidden" })).notSubmitted, true);
      assert.equal(privateTurnIntents.size, 0);
    } finally { release.resolve(); await blocking; await service.stop(); }
  });
  await withHome(async (home) => {
    const fixture = nativeFixture();
    let refuseStop = true;
    const service = createCollaboration({ directory: home, pollMs: 5, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client, abortThread: (...args) => refuseStop ? { accepted: false } : client.abortThread(...args) };
    } });
    const input = { slug: "scout", threadId: "ses_existing", messageId: "msg_existing", prompt: "Hello" };
    const owner = { slug: input.slug, threadId: input.threadId, conversationId: input.threadId, kind: "private" };
    const commands = runInNewContext(`({${source.slice(start, end)}})`, {
      privateTurnIntents: new Map(), assertExpectedReadiness: () => {}, collaboration: service, privateOwner: () => service.registerOwner(owner),
    });
    try {
      await service.registerOwner(owner);
      await service.updateThread(input.slug, input.threadId, { pending: null, next: [] }, { pending: { messageId: input.messageId, prompt: input.prompt, stoppedAt: null, startedAt: 1 }, next: [] });
      fixture.histories.set(input.threadId, [{ id: input.messageId, role: "user", parts: [] }]);
      fixture.held.add(input.threadId);
      await assert.rejects(commands["turns.cancel"](input), /not confirmed/);
      assert.equal(fixture.held.has(input.threadId), true);
      assert.deepEqual(fixture.aborted, []);
      refuseStop = false;
      assert.equal((await commands["turns.cancel"](input)).ok, true);
      assert.deepEqual(fixture.aborted, [input.threadId]);
      assert.equal(fixture.requests.length, 0);
    } finally { await service.stop(); }
  });
});

test("native collaboration preserves accepted turns through unavailable observations and honors Stop and deadlines", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  for (const action of ["recover", "cancel", "deadline", "forbidden"]) await withHome(async (home) => {
    const sending = Promise.withResolvers(), acknowledge = Promise.withResolvers();
    const fixture = nativeFixture(async () => { if (action === "recover") { sending.resolve(); await acknowledge.promise; } });
    const owner = { ...fixtureIdentity, workspaceId: "workspace_scout", slug: "scout", threadId: "ses_observation", conversationId: "ses_observation", kind: "private" };
    const messageId = "msg_observation";
    let unavailable = true;
    let failedSnapshot = false;
    let waits = 0;
    const project = (snapshot) => ({ ...snapshot, native: {
      engine: "v2", pendingInputIds: [], ambiguousTurns: [],
      turnOutcomes: unavailable ? {} : { [messageId]: "succeeded" },
    } });
    const service = createCollaboration({ directory: home, pollMs: 5, stepTimeoutMs: action === "deadline" ? 150 : 3000,
      clientFor: async (slug) => {
        const client = await fixture.clientFor(slug);
        return { ...client,
          getThreadSnapshot: async (...args) => {
            if (fixture.requests.length && !failedSnapshot) {
              failedSnapshot = true;
              throw new HeadlessThreadError({ code: "request_failed", method: "GET", path: "/session/active", status: 503, message: "Fixture unavailable" });
            }
            return project(await client.getThreadSnapshot(...args));
          },
          waitForThread: async (...args) => {
            waits++;
            if (unavailable) throw new HeadlessThreadError({ code: action === "forbidden" ? "request_failed" : "observation_unavailable", method: "GET", path: "/session/active", ...(action === "forbidden" ? { status: 403 } : {}), message: "Fixture observation failed" });
            const result = await client.waitForThread(...args);
            return { ...result, snapshot: project(result.snapshot) };
          },
        };
      },
    });
    try {
      const entry = await service.submit({ owner, messageId, prompt: "Hello", track: true });
      if (action === "recover") {
        await withAbort(sending.promise, AbortSignal.timeout(4000));
        const activity = (await service.activityEntries(owner))[0];
        assert.equal(activity.admission.phase, "attempted");
        assert.equal(activity.admission.confirmed, false);
        assert.equal(activity.admission.inFlight, "sending", "a live native send is not a lost acknowledgement");
        acknowledge.resolve();
      }
      await service.acceptance(entry.id);
      await eventually(() => waits > 0);
      const readActivity = runInNewContext(`${source.slice(source.indexOf("async function readCollaborationActivity("), source.indexOf("function workerKey("))}\nreadCollaborationActivity`, {
        serverHandle: { url: "http://127.0.0.1:8790", managedOpencodeV2: { isAlive: () => true } }, collaboration: service, coworkersDir: home, ownerToken: "fixture", AbortSignal,
        getCoworker: (_directory, slug) => fixtureCoworker(slug), PROGRESS_LIMITS: { maxActivityExecutions: 16, activityReadTimeoutMs: 1000 },
        readExecutionActivity: async () => { throw new Error("GET observation unavailable"); }, progressSummaries: { noteFor: () => null },
      });
      const accepted = (await readActivity(owner))[0];
      assert.equal(accepted.admission.confirmed, true);
      assert.equal(accepted.admission.inFlight, null);
      assert.equal(accepted.available, false);
      assert.equal(accepted.nativeStatus, "unknown");
      if (action === "recover" || action === "cancel") {
        assert.equal((await service.read((state) => state.executions[entry.id])).state, "running");
        assert.deepEqual(fixture.aborted, []);
      }
      if (action === "recover") {
        unavailable = false;
        await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "succeeded");
        assert.deepEqual(fixture.aborted, []);
      } else if (action === "cancel") {
        await service.cancelThread(owner.slug, owner.threadId, messageId);
        assert.equal((await service.read((state) => state.executions[entry.id])).state, "cancelled");
      } else {
        await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "failed");
        if (action === "forbidden") assert.equal(waits, 1);
      }
      if (action !== "recover") await eventually(() => fixture.aborted.length === 1);
      assert.equal(fixture.requests.length, 1);
    } finally { acknowledge.resolve(); await service.stop(); }
  });
});

test("native collaboration rejects completed assistants from interrupted live and recovered turns", async () => {
  for (const recovered of [false, true]) await withHome(async (home) => {
    const fixture = nativeFixture();
    const owner = { slug: "scout", threadId: "ses_receipt", conversationId: "ses_receipt", kind: "private" };
    const messageId = "msg_receipt";
    const native = { engine: "v2", pendingInputIds: [], turnOutcomes: { [messageId]: "interrupted", msg_other: "succeeded" } };
    let captures = 0;
    const options = { directory: home, pollMs: 5, onSuccess: async () => { captures++; }, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client,
        getThreadSnapshot: async (...args) => ({ ...await client.getThreadSnapshot(...args), native }),
        waitForThread: async (...args) => { const result = await client.waitForThread(...args); return { ...result, snapshot: { ...result.snapshot, native } }; },
      };
    } };
    let service = createCollaboration({ ...options, pollMs: 60_000 });
    try {
      const entry = await service.submit({ owner, messageId, prompt: "Keep the earlier work", track: true });
      if (recovered) {
        await (await fixture.clientFor(owner.slug)).sendTurn(owner.threadId, { messageId, prompt: entry.prompt });
        await service.change((state) => { Object.assign(state.executions[entry.id], { state: "running", sentAt: Date.now() }); });
      }
      await service.stop();
      service = createCollaboration(options);
      await service.start();
      await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "failed");
      const failed = await service.read((state) => state.executions[entry.id]);
      assert.match(failed.error, /interrupted/);
      assert.equal(failed.result, "");
      assert.equal(captures, 0, "an interrupted native receipt cannot publish memory");
      assert.equal(fixture.requests.length, 1, "recovery never resends the completed history");
      assert.notEqual(fixture.histories.get(owner.threadId).at(-1).completedAt, null);
    } finally { await service.stop(); }
  });
});

test("native collaboration recovers inbox-only acceptance and fences uncertain admission across restart", async () => {
  for (const phase of ["inbox", "attempted", "prepared", "legacy-running", "legacy-retry", "legacy-queued-retry", "legacy-cleared-retry"]) await withHome(async (home) => {
    const clearedRetry = ["legacy-queued-retry", "legacy-cleared-retry"].includes(phase);
    const retryOnSubmit = ["legacy-retry", "legacy-cleared-retry"].includes(phase);
    const fixture = nativeFixture();
    const owner = { slug: "scout", threadId: "ses_inbox", conversationId: "ses_inbox", kind: "private" };
    const messageId = "msg_inbox";
    const native = { engine: "v2", pendingInputIds: phase === "inbox" ? [messageId] : [], turnOutcomes: { msg_other: "succeeded" } };
    const waiting = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const options = { directory: home, pollMs: 5, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client,
        getThreadSnapshot: async (...args) => ({ ...await client.getThreadSnapshot(...args), native }),
        sendTurn: async (threadId, input) => {
          const acceptance = await client.sendTurn(threadId, { ...input, beforeInput: async () => {
            await input.beforeInput?.();
            const stored = JSON.parse(await readFile(path.join(home, ".collaboration", "state.json"), "utf8"));
            assert.equal(Object.values(stored.executions)[0].nativeAdmission, "attempted", "the attempt is durable before input");
          } });
          native.turnOutcomes[messageId] = "succeeded";
          return acceptance;
        },
        waitForThread: async (threadId, input) => {
          assert.equal(input.since.messageId, messageId);
          waiting.resolve();
          await withAbort(finish.promise, input.signal);
          return { outcome: "settled", snapshot: { ...await client.getThreadSnapshot(threadId), native }, terminalError: null };
        },
      };
    } };
    let service = createCollaboration({ ...options, pollMs: 60_000 });
    try {
      const model = { providerId: "fixture", modelId: "text", variant: "low" };
      const entry = await service.submit({ owner, messageId, prompt: "Keep this exact input", model });
      await service.change((state) => {
        Object.assign(state.executions[entry.id], {
          state: retryOnSubmit ? "failed" : clearedRetry ? "queued" : "running",
          sentAt: clearedRetry || phase === "legacy-running" ? null : Date.now(),
          ...(["prepared", "attempted"].includes(phase) ? { nativeAdmission: phase } : {}),
          ...(clearedRetry ? { acceptance: null, retry: phase === "legacy-queued-retry", attempts: 1, generatedMessageId: true } : {}),
        });
        if (retryOnSubmit) state.tasks[entry.taskId].state = "failed";
      });
      await service.stop();
      service = createCollaboration(options);
      assert.equal((await service.activityEntries(owner))[0].admission.inFlight, null, "a persisted running flag is not live admission evidence");
      if (clearedRetry) {
        const saved = await service.read((state) => state.executions[entry.id]);
        assert.equal(saved.nativeAdmission, undefined);
        assert.equal(saved.sentAt, null);
        assert.equal(saved.acceptance, null);
        assert.equal(saved.state, retryOnSubmit ? "failed" : "queued");
        assert.equal(saved.retry, !retryOnSubmit);
        assert.equal(saved.attempts, 1);
      }
      await service.start();
      if (retryOnSubmit) await service.submit({ ...entry, retry: true, retryByPerson: true });
      if (phase === "inbox") {
        await withAbort(waiting.promise, AbortSignal.timeout(4000));
        assert.equal((await service.read((state) => state.executions[entry.id])).state, "running", "another turn's success cannot settle this inbox input");
        assert.equal(fixture.requests.length, 0);
        fixture.histories.set(owner.threadId, [
          { id: messageId, role: "user", parts: [] },
          { id: "assistant_inbox", role: "assistant", parentId: messageId, completedAt: 1, parts: [{ type: "text", text: "Confirmed result" }] },
        ]);
        native.pendingInputIds = [];
        native.turnOutcomes[messageId] = "succeeded";
        finish.resolve();
      }
      await eventually(async () => ["failed", "succeeded"].includes((await service.read((state) => state.executions[entry.id])).state));
      const settled = await service.read((state) => state.executions[entry.id]);
      const failed = !["inbox", "prepared"].includes(phase);
      assert.deepEqual(settled.model, model, "recovery keeps the accepted model and effort pin");
      assert.equal(settled.state, failed ? "failed" : "succeeded");
      assert.equal(fixture.requests.length, phase === "prepared" ? 1 : 0);
      if (failed) assert.match(settled.error, /will not be replayed/);
      else assert.equal(settled.nativeAdmission, "attempted");
      if (clearedRetry) assert.equal(settled.messageId, messageId, "uncertain recovery cannot rotate the original input ID");
      if (retryOnSubmit) assert.equal(settled.nativeAdmission, "attempted", "retry resets retain the conservative phase");
    } finally { finish.resolve(); await service.stop(); }
  });
});

test("native Stop shares cleanup across cancellation and observer release", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ threadId, input }) => { if (input.prompt === "Hold") fixture.held.add(threadId); });
    const entered = Promise.withResolvers(), release = Promise.withResolvers();
    let stops = 0, endings = 0;
    const service = createCollaboration({ directory: home, pollMs: 5, onExecutionEnd: async () => { endings++; }, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client, abortThread: async (id) => {
        if (++stops > 1) throw new Error("Concurrent native Stop");
        entered.resolve(); await release.promise;
        return client.abortThread(id);
      } };
    } });
    try {
      const owner = { slug: "scout", threadId: "ses_stop", conversationId: "ses_stop", kind: "private" };
      const entry = await service.submit({ owner, messageId: "msg_stop", prompt: "Hold" });
      await service.acceptance(entry.id);
      const cancelling = Promise.all([service.cancel(entry.id), service.cancel(entry.id)]);
      void cancelling.catch(() => {});
      await withAbort(entered.promise, AbortSignal.timeout(1000));
      release.resolve(); await cancelling;
      await eventually(() => fixture.aborted.length === 1);
      assert.equal(stops, 1);
      assert.equal(endings, 1);
      const next = await service.submit({ owner: { ...owner, threadId: "ses_after", conversationId: "ses_after" }, messageId: "msg_after", prompt: "After Stop" });
      await service.wait(next.id);
    } finally { release.resolve(); await service.stop({ requireConfirmed: true }); }
  });
});

test("context-only attempted recovery drains its own inbox across restart and terminal Stop", async () => {
  for (const recover of [true, false]) await withHome(async (home) => {
    const fixture = nativeFixture();
    const owner = { slug: "scout", threadId: "ses_context", conversationId: "ses_context", kind: "private" };
    const messageId = "msg_context", contextId = `${messageId}_context`;
    const model = { providerId: "fixture", modelId: "text" };
    let pending = [], agent, deleted = 0;
    const options = { directory: home, pollMs: recover ? 5 : 60_000, setupTimeoutMs: 100, clientFor: async (slug) => ({
      ...await fixture.clientFor(slug),
      getThreadSnapshot: async () => ({ threadId: owner.threadId, status: { type: "idle" }, messages: [], native: { engine: "v2", pendingInputIds: pending.map((item) => item.id), turnOutcomes: {} } }),
      nativeSkills: {
        getSession: async () => ({ id: owner.threadId, agent, model: { providerID: model.providerId, id: model.modelId }, time: {} }),
        readHistory: async () => [], readInbox: async () => pending, readActive: async () => ({}),
        reconcileInput: async (_id, input) => pending.length ? { state: "queued", receipt: pending.find((item) => item.id === input.id) } : { state: "unobserved", id: input.id },
        cancelInput: async (id, inputId) => { assert.equal(id, owner.threadId); assert.equal(inputId, contextId); deleted++; pending = []; },
      },
    }) };
    let service = createCollaboration({ ...options, pollMs: 60_000 });
    const entry = await service.submit({ owner, messageId, prompt: "Never replay", model });
    agent = entry.agent;
    pending = [{ id: contextId, type: "synthetic", delivery: "steer", payload: { text: "Reference", metadata: { headlessTurn: { version: 1, messageId, contextId, previousMessageId: null, previousIdleAt: null, previousOutcome: null, model: { providerID: model.providerId, id: model.modelId }, agent } } } }];
    await service.change((state) => {
      Object.assign(state.executions[entry.id], { state: recover ? "running" : "failed", sentAt: Date.now(), nativeAdmission: "attempted", context: "Reference", workspaceId: "workspace_scout" });
      state.tasks[entry.taskId].state = recover ? "running" : "failed";
    });
    await service.stop();
    service = createCollaboration(options);
    try {
      if (recover) {
        await service.start();
        await eventually(async () => (await service.read((state) => state.executions[entry.id])).state === "failed");
      } else {
        pending[0].payload.metadata.headlessTurn.agent = "another-agent";
        await assert.rejects(service.cancel(entry.id), /could not be confirmed/);
        assert.equal(deleted, 0, "a mismatched context must not be removed");
        assert.equal(await service.read((state) => state.executions[entry.id].cleanupPending), true, "idle with the owned inbox input still present is not cessation");
        pending[0].payload.metadata.headlessTurn.agent = agent;
        await service.cancel(entry.id);
      }
      assert.equal(deleted, 1);
      assert.equal(pending.length, 0);
      await service.cancel(entry.id);
      assert.equal(deleted, 1);
      assert.equal(fixture.requests.length, 0);
      assert.deepEqual(fixture.aborted, []);
    } finally { await service.stop(); }
  });
});

test("Activity recovery preserves creation identity and never backfills a missing pin", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const replacement = "2026-09-12T00:00:00.000Z";
    const options = { directory: home, pollMs: 5, clientFor: async (slug) => ({ ...await fixture.clientFor(slug), coworkerCreatedAt: replacement }) };
    let service = createCollaboration({ ...options, pollMs: 60_000 });
    const owner = { ...fixtureIdentity, slug: "scout", workspaceId: "workspace_scout", threadId: "replacement", conversationId: "replacement", kind: "private" };
    try {
      const original = await service.submit({ owner, messageId: "queued-original", prompt: "Do not move this work" });
      const legacy = await service.submit({ owner: { ...owner, threadId: "legacy-pin", conversationId: "legacy-pin", coworkerCreatedAt: null }, messageId: "missing-pin", prompt: "Legacy work" });
      const child = await service.request({ entry: legacy, callId: "worker" }, "worker", { name: "Legacy result", goal: "Old check" });
      await service.completeWorker({ slug: "scout", id: child.structured.worker.id, status: "finished" }, [{ kind: "finding", report: "done", text: "Recovered result" }]);
      await service.change((state) => {
        delete state.tasks[legacy.taskId].coworkerCreatedAt;
        delete state.executions[legacy.id].coworkerCreatedAt;
      });
      await service.stop();
      service = createCollaboration(options);
      await service.start();
      await eventually(async () => (await service.read((state) => state.executions[original.id])).state === "failed" && (await service.read((state) => state.tasks[legacy.taskId])).state === "succeeded");
      assert.equal(fixture.requests.some((request) => request.messageId === original.messageId), false, "same workspace, different creation identity cannot admit old work");
      assert.equal(await service.read((state) => state.tasks[original.taskId].coworkerCreatedAt), fixtureCreatedAt);
      const followup = await service.read((state) => state.executions[state.tasks[legacy.taskId].executionId]);
      assert.equal(followup.continuation, true);
      assert.equal(followup.coworkerCreatedAt, null, "client admission cannot fill an old task's missing identity");
      assert.deepEqual(await service.listActivity(), []);
      await service.submit({ owner: { ...owner, coworkerCreatedAt: replacement }, messageId: "fresh-replacement", prompt: "New request" });
      await eventually(async () => (await service.listActivity()).length === 1);
      assert.equal((await service.listActivity())[0].coworkerCreatedAt, replacement);
      await service.change((state) => { delete state.activity[0].coworkerCreatedAt; });
      const inbox = createActivityInbox({ collaboration: service, coworkers: async () => [{ ...await fixtureCoworker("scout"), createdAt: replacement }], groups: async () => [] });
      assert.deepEqual(await inbox.list(), [], "an old index row without creation identity also fails closed");
    } finally { await service.stop(); }
  });
});

test("Activity persists only final private text, explicit read state, and original workspace identity", async () => {
  await withHome(async (home) => {
    let clock = 1000;
    const fixture = nativeFixture(async ({ input, reply, threadId }) => {
      reply.parts.push({ type: "reasoning", text: "SECRET REASONING @you" }, { type: "text", text: "HIDDEN @you", synthetic: true });
      reply.parts[0].toolOutput = "SECRET TOOL @you";
      fixture.histories.get(threadId).splice(-1, 0, { id: `early_${reply.id}`, role: "assistant", parentId: input.messageId, completedAt: 1, parts: [{ type: "text", text: "TOOL ACK @you" }] });
      if (input.prompt === "fail") reply.error = { message: "Deliberate failure" };
      return input.prompt === "long" ? `${"Visible result. ".repeat(35)}@YOU, which option?` : "Final visible answer.";
    });
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5, now: () => clock, onSuccess: async () => { throw new Error("Optional memory capture unavailable"); } };
    let service = createCollaboration(options);
    let actors = [await fixtureCoworker("scout")];
    const inbox = () => createActivityInbox({ collaboration: service, coworkers: async () => actors, groups: () => listGroups(home) });
    const owner = { ...fixtureIdentity, slug: "scout", threadId: "ses_inbox", conversationId: "ses_inbox", kind: "private" };
    try {
      for (const prompt of ["plain", "long", "fail"]) {
        const entry = await service.submit({ owner, messageId: `msg_${prompt}`, prompt, track: true });
        await eventually(async () => ["succeeded", "failed"].includes((await service.read((state) => state.executions[entry.id])).state));
        clock += 100;
      }
      const items = await inbox().list();
      assert.equal(items.length, 2);
      assert.deepEqual(items.map((item) => item.kind), ["mention", "reply"]);
      assert.equal(items[0].preview.length, 400, "classification uses the complete final text before clipping");
      assert.equal(items[1].preview, "Final visible answer.", "no earlier acknowledgements, tool output, synthetic text or reasoning");
      assert.deepEqual(items[0].target, { kind: "private", threadId: owner.threadId });
      assert.equal(items[0].workspaceId, "workspace_scout");
      assert.equal(items[0].coworkerCreatedAt, fixtureCreatedAt);
      assert.equal(items[0].readAt, null);
      await inbox().markRead([items[0].id, items[0].id, "unknown"]);
      clock += 100;
      let read = await inbox().markRead([items[0].id]);
      assert.equal(read[0].readAt, 1300, "idempotent Read keeps the first native timestamp");
      assert.equal(read[1].readAt, null, "unlisted IDs stay unread");
      assert.deepEqual(await inbox().markRead([]), read);
      for (const ids of [undefined, [""], [1], Array(301).fill(items[0].id)]) await assert.rejects(inbox().markRead(ids), /300 Activity IDs/);
      await assert.rejects(inbox().markRead([items[0].id], "yes"), /read or unread/);
      await service.stop();
      service = createCollaboration(options);
      assert.deepEqual(await inbox().list(), read);
      await service.submit({ owner, messageId: "msg_long", prompt: "long", track: true });
      assert.deepEqual(await inbox().list(), read, "replaying admission preserves the item and readAt");
      assert.equal(fixture.requests.length, 3);
      read = await inbox().markRead([items[0].id], false);
      assert.equal(read[0].readAt, null);
      actors = [{ ...await fixtureCoworker("scout"), createdAt: "2026-09-12T00:00:00.000Z" }];
      assert.deepEqual(await inbox().list(), []);
      assert.deepEqual(await inbox().markRead([items[0].id]), []);
      assert.equal((await service.listActivity())[0].readAt, null, "a hidden source cannot be marked by guessing its ID");
      actors = [];
      assert.deepEqual(await inbox().list(), []);
    } finally { await service.stop(); }
  });
});

test("Activity source receipts survive bounded pruning and restart", async () => {
  await withHome(async (home) => {
    const options = { directory: home, clientFor: nativeFixture().clientFor };
    let service = createCollaboration(options);
    try {
      await service.change((state) => {
        for (let index = 0; index <= MAX_ACTIVITY_ITEMS; index++) {
          const id = `source_${index}`;
          const owner = { slug: "scout", kind: "private", threadId: "private", conversationId: "private" };
          state.tasks[id] = { id, state: "succeeded", executionId: id, activityEligible: true };
          const entry = state.executions[id] = { ...fixtureIdentity, id, taskId: id, owner, state: "succeeded", workspaceId: "workspace_scout" };
          recordActivity(state, entry, { text: "Visible result", at: index });
        }
      });
      const items = await service.listActivity();
      assert.equal(items.length, MAX_ACTIVITY_ITEMS);
      assert.deepEqual([items[0].at, items.at(-1).at], [300, 1]);
      await service.stop();
      service = createCollaboration(options);
      await service.change((state) => recordActivity(state, state.executions.source_0, { text: "Replayed result", at: 999 }));
      assert.deepEqual(await service.listActivity(), items, "a pruned source cannot reappear with a newer timestamp");
      assert.equal(await service.read((state) => state.executions.source_0.activityRecorded), true);
    } finally { await service.stop(); }
  });
});

test("Activity migration keeps old origins, reconstructed continuations and queued group history silent", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const options = { directory: home, clientFor: fixture.clientFor, pollMs: 5 };
    let service = createCollaboration({ ...options, pollMs: 60_000 });
    const groupOptions = { directory: home, clientFor: fixture.clientFor, coworkerFor: fixtureCoworker, coordinator: async () => ({}), catalogFor: async () => ({ models: [] }) };
    let groups = createGroupExecution({ ...groupOptions, collaboration: service, pollMs: 60_000 });
    const owner = { slug: "scout", threadId: "legacy", conversationId: "legacy", kind: "private" };
    try {
      const group = await createGroup(home, { name: "Old group", participantSlugs: ["scout", "editor"] });
      const root = await service.submit({ owner, messageId: "old_origin", prompt: "Old origin" });
      const worker = await service.request({ entry: root, callId: "old_child" }, "worker", { name: "Old worker", goal: "Old check" });
      await service.completeWorker({ id: worker.structured.worker.id, slug: "scout", status: "finished" }, [{ kind: "finding", report: "done", text: "Old findings" }]);
      await groups.submit(group.id, { clientMessageId: "old_group", text: "@scout Old group turn" });
      await groups.stop();
      await service.stop();
      const file = path.join(home, ".collaboration", "state.json");
      const legacy = JSON.parse(await readFile(file, "utf8"));
      delete legacy.activity;
      for (const task of Object.values(legacy.tasks)) delete task.activityEligible;
      for (const request of legacy.groups[group.id].queue) { delete request.activityEligible; delete request.coworkerCreatedAts; }
      await writeFile(file, JSON.stringify(legacy));
      service = createCollaboration(options);
      groups = createGroupExecution({ ...groupOptions, collaboration: service, pollMs: 5 });
      await service.start();
      await groups.start();
      await eventually(async () => (await service.read((state) => state.tasks[root.taskId])).state === "succeeded" && !(await groups.status(group.id)).active);
      assert.ok(fixture.requests.some((request) => request.prompt.startsWith("Continue the original task")));
      assert.deepEqual(await service.listActivity(), []);
      const reconstructed = { slug: "scout", id: "wrk_reconstructed", name: "Old Worker", goal: "Old result", status: "finished" };
      await service.attachWorker(reconstructed, owner);
      await service.completeWorker(reconstructed, [{ kind: "finding", report: "done", text: "Recovered findings" }]);
      await eventually(async () => (await service.receipts({ slug: owner.slug, threadId: owner.threadId })).every((receipt) => receipt.state === "succeeded"));
      assert.deepEqual(await service.listActivity(), []);
      await service.submit({ owner: { ...owner, ...fixtureIdentity }, messageId: "new_origin", prompt: "New origin" });
      await eventually(async () => (await service.listActivity()).length === 1);
    } finally { await groups.stop(); await service.stop(); }
  });
});

test("idle collaboration does not copy settled history and still accepts new work", async (t) => {
  await withHome(async (home) => {
    let clock = Date.now();
    const integrated = await eventFixture(home, { startGroups: false, now: () => clock });
    const { native: fixture, collaboration: service, events } = integrated;
    const owner = { slug: "scout", threadId: "ses_idle", conversationId: "ses_idle", kind: "private" };
    await service.change((state) => {
      state.tasks.settled = { id: "settled", owner, state: "succeeded", result: "kept history ".repeat(10_000) };
    });
    const clone = globalThis.structuredClone;
    let historyCopies = 0;
    let reads = 0;
    const spy = t.mock.method(globalThis, "structuredClone", (value) => {
      if (value?.tasks || (Array.isArray(value) && value.some((entry) => entry?.id === "settled"))) historyCopies++;
      reads++;
      return clone(value);
    });
    try {
      await service.start();
      await Promise.all([events.tick(), events.tick()]);
      await eventually(() => reads >= 10);
      assert.equal(historyCopies, 0, "idle collaboration and Event ticks must not clone the store or completed task payloads");
      const startsAt = clock + EVENT_REMINDER_LEAD_MS + 60_000;
      const input = { ...eventInput(["scout"]), startsAt, schedule: { kind: "once", at: startsAt, timezone: "Etc/UTC" } };
      const future = await events.create(input);
      const paused = await events.create({ ...input, state: "paused" });
      historyCopies = 0;
      await events.tick();
      assert.equal(historyCopies, 0, "future and paused definitions require no history copies");
      clock = startsAt;
      await Promise.all([events.tick(), events.tick()]);
      const due = await events.get(future.id);
      assert.equal(due.runs.length, 1);
      assert.equal(due.runs[0].scheduledFor, startsAt);
      assert.equal(due.runs[0].status, "running", "a newly due occurrence still reaches group admission");
      assert.equal((await events.get(paused.id)).runs.length, 0);
      await events.cancel(future.id, due.runs[0].id);
      const manual = await events.runNow(paused.id, "manual-after-idle");
      await events.tick();
      assert.equal((await events.get(paused.id)).runs[0].status, "running", "manual admissions advance even when no schedule is due");
      await events.cancel(paused.id, manual.id);
      historyCopies = 0;
      await events.tick();
      assert.equal(historyCopies, 0, "finished Event history stays idle after cancellation");
      spy.mock.restore();
      await service.submit({ owner, messageId: "msg_after_idle", prompt: "New work", track: true });
      await eventually(async () => fixture.requests.length === 1 && (await service.threadState(owner.slug, owner.threadId)).pending === null);
      assert.equal(fixture.requests[0].prompt, "New work");
      assert.equal(await service.read((state) => state.tasks.settled.result.length), "kept history ".length * 10_000);
    } finally { spy.mock.restore(); await integrated.stop(); }
  });
});

test("automatic memory captures only terminal private success and recalls raw requests in a new thread", async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, "scout"));
    const owner = { ...fixtureIdentity, slug: "scout", threadId: "private-first", conversationId: "private-first", kind: "private" };
    const prompt = "My release checklist has exactly 17 items.";
    const captured = [];
    const memory = createConversationMemory({ directory: home });
    let service;
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (input.prompt === prompt) {
        const context = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
        await service.request(context, "worker", { name: "Checklist check", goal: "Check the checklist once." });
      }
      if (input.prompt === "This turn fails.") reply.error = { message: "Deliberate native failure" };
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      memoryContext: (owner) => memory.context(owner),
      onSuccess: async (entry) => { await memory.capture(entry); captured.push(entry); },
      spawn: async (slug, input) => {
        await service.completeWorker({ slug, id: input.id, status: "finished" }, [{ kind: "finding", text: "Checklist checked." }]);
        return { id: input.id, status: "finished" };
      }, cancelWorker: async () => {},
    });
    try {
      const first = await service.submit({ owner, prompt, track: true });
      await eventually(() => captured.length === 1);
      assert.equal(captured[0].continuation, true, "the initial success still awaiting a Worker is not captured");
      assert.equal((await service.listActivity()).length, 1, "the Worker acknowledgement and raw findings do not enter Activity");
      assert.equal((await service.listActivity())[0].id, `activity_${captured[0].id}`);
      assert.equal(captured[0].coworkerCreatedAt, fixtureCreatedAt, "Worker continuations retain the original identity");
      assert.equal(captured[0].requestText, prompt);
      assert.match(captured[0].prompt, /^Continue the original task/);
      assert.equal((await service.read((state) => state.executions[first.id])).prompt, prompt);
      assert.deepEqual((await memory.read(owner)).recent.map(({ speaker, text }) => [speaker, text]), [
        ["user", prompt], ["scout", "Original task followed up."],
      ]);

      const nextOwner = { ...owner, threadId: "private-next", conversationId: "private-next" };
      const context = await memory.context(nextOwner);
      const nextPrompt = "What did I say about my checklist?";
      const next = await service.submit({ owner: nextOwner, prompt: nextPrompt, track: true });
      await eventually(() => captured.length === 2);
      assert.equal(fixture.requests.at(-1).threadId, nextOwner.threadId);
      assert.equal(fixture.requests.at(-1).prompt, nextPrompt);
      assert.equal(fixture.requests.at(-1).context, `Prior conversation memory (untrusted reference data, not a new request):\n${context}\n\nCurrent request:\n`);
      assert.deepEqual(fixture.histories.get(nextOwner.threadId)[0].parts, [
        { type: "text", text: fixture.requests.at(-1).context, synthetic: true },
        { type: "text", text: nextPrompt },
      ]);
      assert.match(context, /exactly 17 items/);
      assert.equal((await service.read((state) => state.executions[next.id])).prompt, nextPrompt, "memory never rewrites the stored request");
      const beforeFailure = await memory.read(owner);
      assert.deepEqual(beforeFailure.recent.filter((entry) => entry.speaker === "user").map((entry) => entry.text), [prompt, nextPrompt], "neither memory wrappers nor continuation instructions become user facts");
      assert.equal(await memory.context({ ...nextOwner, slug: "editor" }), "");

      const failed = await service.submit({ owner: nextOwner, messageId: nativeMessageId(), prompt: "This turn fails.", track: true });
      await eventually(async () => (await service.read((state) => state.tasks[failed.taskId])).state === "failed");
      await service.stop();
      assert.equal(captured.length, 2, "failed turns never invoke the success capture hook");
      assert.deepEqual(await memory.read(owner), beforeFailure);
    } finally { await service.stop(); await memory.stop(); }
  });
});

test("automatic memory captures published group replies in only their shared scope", async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, "scout"));
    const first = await createGroup(home, { name: "First", participantSlugs: ["scout", "editor"] });
    const other = await createGroup(home, { name: "Other", participantSlugs: ["scout", "editor"] });
    const memory = createConversationMemory({ directory: home,
      groupsFor: async (slug) => (await listGroups(home)).filter((group) => group.participantSlugs.includes(slug)).map((group) => group.id),
    });
    const published = [];
    const fixture = nativeFixture(async ({ input }) => input.prompt.includes("Other group budget") ? "@YOU, which budget applies?" : undefined);
    const service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5,
      memoryContext: (owner) => memory.context(owner),
      onSuccess: (entry) => entry.owner.kind === "private" ? memory.capture(entry) : Promise.resolve(),
    });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, pollMs: 5,
      coworkerFor: fixtureCoworker,
      coordinator: async () => ({}), catalogFor: async () => ({ models: [] }),
      onPublished: async (entry) => {
        const timeline = await readGroupTimeline(home, entry.owner.groupId);
        const stored = await service.read((state) => state.executions[entry.id]);
        await memory.capture(entry);
        published.push({ entry, timeline, marked: stored.groupReply.published });
      },
    });
    try {
      const privateOwner = { ...fixtureIdentity, slug: "scout", threadId: "private", conversationId: "private", kind: "private" };
      await service.submit({ owner: privateOwner, prompt: "PRIVATE CHECKLIST", track: true });
      await eventually(async () => (await memory.read(privateOwner)).recent.length === 2);
      await groups.start();
      const messages = ["@scout First group budget is 17.", "@scout Other group budget is 29.", "@scout Recall our budget."];
      for (const [index, group] of [first, other, first].entries()) {
        await groups.submit(group.id, { clientMessageId: `memory-${index}`, text: messages[index] });
        await eventually(async () => !(await groups.status(group.id)).active);
      }
      assert.equal(published.length, 3);
      for (const { entry, timeline, marked } of published) {
        assert.equal(marked, true);
        assert.ok(timeline.some((event) => event.kind === "coworker" && event.threadId === entry.owner.threadId && event.turnId === entry.owner.turnId && event.text === entry.result), "capture follows actual timeline publication");
        const item = (await service.listActivity()).find((item) => item.id === `activity_${entry.id}`);
        assert.equal(item.kind, entry.owner.groupId === other.id ? "mention" : "reply", "group replies and human mentions each produce one row");
        assert.deepEqual(item.target, { kind: "group", groupId: entry.owner.groupId, eventId: timeline.find((event) => event.executionId === entry.id).id });
      }
      assert.equal((await service.listActivity()).length, 4, "a group mention does not also create a reply row");
      let actors = [await fixtureCoworker("scout")];
      const inbox = createActivityInbox({ collaboration: service, coworkers: async () => actors, groups: () => listGroups(home) });
      actors = [{ ...actors[0], createdAt: "2026-09-12T00:00:00.000Z" }];
      assert.deepEqual(await inbox.list(), [], "same path/workspace replacement cannot see private or group sources");
      actors = [await fixtureCoworker("scout")];
      await updateGroup(home, other.id, { participantSlugs: ["editor", "ops"] });
      assert.equal((await inbox.list()).some((item) => item.target.groupId === other.id), false, "removed members cannot reveal old shared Activity");
      await archiveGroup(home, first.id);
      assert.equal((await inbox.markRead((await service.listActivity()).map((item) => item.id))).length, 1, "markRead returns the same current membership filters");
      const firstOwner = { slug: "scout", kind: "group", groupId: first.id };
      const store = await memory.read(firstOwner);
      assert.deepEqual(store.recent.filter((entry) => entry.speaker === "user").map((entry) => entry.text), [messages[0], messages[2]], "group prompt wrappers are not user facts");
      assert.deepEqual(await memory.read({ ...firstOwner, slug: "editor" }), store, "participants share the same group scope");
      const requests = fixture.requests.slice(1);
      assert.equal(requests[0].context, undefined);
      assert.equal(requests[1].context, undefined);
      assert.doesNotMatch(requests[0].prompt, /PRIVATE CHECKLIST|Prior conversation memory/);
      assert.doesNotMatch(requests[1].prompt, /PRIVATE CHECKLIST|First group budget|Prior conversation memory/);
      assert.equal(requests[2].prompt, published[2].entry.prompt);
      assert.doesNotMatch(requests[2].prompt, /PRIVATE CHECKLIST|Other group budget|Prior conversation memory/);
      assert.match(requests[2].context, /^Prior conversation memory/);
      assert.match(requests[2].context, /First group budget is 17/);
      assert.doesNotMatch(requests[2].context, /PRIVATE CHECKLIST|Other group budget/);
      assert.equal(await memory.context({ ...firstOwner, slug: "outsider" }), "");
      assert.deepEqual((await memory.read(privateOwner)).recent.filter((entry) => entry.speaker === "user").map((entry) => entry.text), ["PRIVATE CHECKLIST"]);
    } finally { await groups.stop(); await service.stop(); await memory.stop(); }
  });
});

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

test("shutdown confirms persisted private cleanup with a recovered idle cleanup client without replay", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const owner = { ...fixtureIdentity, slug: "scout", workspaceId: "workspace_scout", threadId: "persisted-stop", conversationId: "persisted-stop", kind: "private" };
    const model = { providerId: "fixture", modelId: "original" };
    const observations = [];
    let endings = 0;
    const options = { directory: home, pollMs: 60_000, setupTimeoutMs: 100,
      clientFor: async () => { assert.fail("Cleanup must not acquire a warmup client."); },
      cleanupClientFor: async (slug, options) => {
        observations.push({ slug, ...options });
        const client = await fixture.clientFor(slug);
        return { ...client, getThreadSnapshot: async (id) => ({ ...await client.getThreadSnapshot(id), native: { engine: "v2", pendingInputIds: [], turnOutcomes: {} } }) };
      },
      onExecutionEnd: async () => { endings++; },
    };
    let service = createCollaboration(options);
    const entry = await service.submit({ owner, messageId: "msg_persisted_stop", prompt: "Keep earlier work", model });
    await service.change((state) => {
      Object.assign(state.executions[entry.id], { state: "failed", sentAt: 1, nativeAdmission: "attempted", context: null, cleanupPending: true, cleanupError: "Earlier cleanup was unavailable" });
      state.tasks[entry.taskId].state = "failed";
    });
    await service.stop();
    service = createCollaboration(options);
    try {
      await service.start();
      assert.equal(await service.read((state) => state.executions[entry.id].cleanupPending), true);
      await service.stop({ requireConfirmed: true });
      const stopped = await service.read((state) => state.executions[entry.id]);
      assert.equal(stopped.cleanupPending, false);
      assert.equal(stopped.cleanupError, "");
      assert.equal(typeof stopped.nativeStoppedAt, "number");
      assert.equal(stopped.state, "failed");
      assert.equal(stopped.sentAt, 1);
      assert.equal(stopped.messageId, entry.messageId);
      assert.equal(observations.length, 1);
      assert.equal(observations[0].slug, owner.slug);
      assert.equal(observations[0].observationOnly, true);
      assert.deepEqual(observations[0].model, model);
      assert.ok(observations[0].signal instanceof AbortSignal);
      await service.stop({ requireConfirmed: true });
      assert.equal(observations.length, 1);
      assert.equal(endings, 1);
      assert.deepEqual(fixture.requests, []);
      assert.deepEqual(fixture.aborted, []);
      await assert.rejects(service.registerOwner({ ...owner, threadId: "late" }), /storage is closed/);
    } finally { await service.stop(); }
  });
});

test("shutdown refuses unconfirmed native cancellation instead of swallowing it", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ threadId }) => { fixture.held.add(threadId); });
    let cleanupCreatedAt = fixtureCreatedAt, aborts = 0;
    const clientFor = async (slug) => ({ ...await fixture.clientFor(slug), abortThread: async () => { aborts++; return { accepted: false }; } });
    const service = createCollaboration({ directory: home, pollMs: 5, setupTimeoutMs: 1_000, clientFor,
      cleanupClientFor: async (slug) => ({ ...await clientFor(slug), coworkerCreatedAt: cleanupCreatedAt }),
    });
    try {
      const entry = await service.submit({ owner: { ...fixtureIdentity, slug: "scout", workspaceId: "workspace_scout", threadId: "shutdown", conversationId: "shutdown", kind: "private" }, prompt: "Hold this step" });
      await eventually(() => fixture.requests.length === 1);
      await assert.rejects(service.stop({ requireConfirmed: true }), /native cleanup could not be confirmed/);
      const pending = await service.read((state) => state.executions[entry.id]);
      assert.equal(pending.cleanupPending, true);
      assert.equal(pending.nativeStoppedAt ?? null, null);
      assert.equal((await stat(home)).isDirectory(), true);
      await assert.rejects(service.submit({ owner: entry.owner, prompt: "Do not restart" }), /closing/);
      await assert.rejects(service.registerOwner({ ...entry.owner, threadId: "late" }), /storage is closed/);
      const refused = aborts;
      cleanupCreatedAt = "2026-09-12T00:00:00.000Z";
      await assert.rejects(service.stop({ requireConfirmed: true }), /native cleanup could not be confirmed/);
      assert.match(await service.read((state) => state.executions[entry.id].cleanupError), /original coworker/);
      cleanupCreatedAt = fixtureCreatedAt;
      fixture.histories.clear();
      await assert.rejects(service.stop({ requireConfirmed: true }), /native cleanup could not be confirmed/);
      assert.match(await service.read((state) => state.executions[entry.id].cleanupError), /no unrelated work was stopped/);
      assert.equal(aborts, refused);
      fixture.held.clear();
      await service.stop({ requireConfirmed: true });
      assert.equal(await service.read((state) => state.executions[entry.id].cleanupPending), false);
      assert.equal(fixture.requests.length, 1);
    } finally { fixture.held.clear(); await service.stop(); }
  });
});

test("shutdown recovers execution-end failures and captures the final Event snapshot with producers closed", async () => {
  await withHome(async (home) => {
    let cleanupAvailable = false, reply;
    const snapshots = [];
    const document = { id: "late-artifact", title: "Kept work", revision: 1 };
    const service = await eventFixture(home, { setupTimeoutMs: 200, readArtifact: async () => document,
      onSend: async (turn) => { reply = turn.reply; },
      onExecutionEnd: async (_entry, snapshot) => { snapshots.push(snapshot?.status.type); if (!cleanupAvailable) throw new Error("Execution control cleanup unavailable"); },
    });
    try {
      const event = await service.events.create({ ...eventInput(["scout"]), state: "paused" });
      const run = await service.events.runNow(event.id, "cleanup-recovery");
      await service.events.tick();
      await eventually(async () => Object.values(JSON.parse(await readFile(path.join(home, ".collaboration", "state.json"), "utf8")).executions).some((entry) => entry.cleanupPending));
      await service.events.stop();
      await service.groups.stop();
      await assert.rejects(service.collaboration.stop({ requireConfirmed: true }), /native cleanup could not be confirmed/);
      const entry = await service.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.owner.eventRunId === run.id));
      assert.equal(entry.state, "succeeded");
      assert.equal(entry.cleanupPending, true);
      assert.match(entry.cleanupError, /Execution control cleanup unavailable/);
      await assert.rejects(service.collaboration.change(() => {}), /storage is closed/);
      reply.parts.push({ type: "tool", tool: "coworker_document_create", callId: "late-artifact", toolStatus: "completed", toolInput: { title: document.title }, toolMetadata: { structuredContent: { document: { ...document, action: "created" } } } });
      cleanupAvailable = true;
      await service.collaboration.stop({ requireConfirmed: true });
      const recovered = await service.collaboration.read((state) => ({ entry: state.executions[entry.id], run: state.workplaceEvents.runs[run.id] }));
      assert.equal(recovered.entry.cleanupPending, false);
      assert.equal(recovered.entry.eventArtifactsCaptured, true);
      assert.deepEqual(recovered.run.artifactErrors, []);
      assert.deepEqual(recovered.run.artifacts.map((artifact) => artifact.documentId), [document.id]);
      assert.equal(recovered.run.artifactReceipts.length, 1);
      assert.deepEqual(snapshots.slice(-2), [undefined, "idle"]);
      const captures = snapshots.length;
      await service.collaboration.stop({ requireConfirmed: true });
      assert.equal(snapshots.length, captures);
      assert.equal(service.native.requests.length, 1);
    } finally { cleanupAvailable = true; await service.stop(); }
  });
});

test("shutdown retries a failed late Worker cancellation by its owning task", async () => {
  await withHome(async (home) => {
    const release = Promise.withResolvers();
    let service, requested, spawning = false, cleanupAvailable = false;
    const stops = [];
    const fixture = nativeFixture(async ({ input }) => {
      const entry = await service.read((state) => Object.values(state.executions).find((entry) => entry.messageId === input.messageId));
      requested = await service.request({ entry, callId: "late-worker" }, "worker", { name: "Late Worker", goal: "Check once" });
    });
    service = createCollaboration({ directory: home, clientFor: fixture.clientFor, pollMs: 5, setupTimeoutMs: 200,
      spawn: async (slug, input) => { spawning = true; await release.promise; return { slug, id: input.id, status: "running" }; },
      cancelWorker: async (slug, id) => { stops.push({ slug, id }); if (!cleanupAvailable) throw new Error("Worker control cleanup unavailable"); },
    });
    try {
      await service.submit({ owner: { slug: "scout", threadId: "late-worker", conversationId: "late-worker", kind: "private" }, prompt: "Delegate once" });
      await eventually(() => spawning);
      const failed = assert.rejects(service.stop({ requireConfirmed: true }), /native cleanup could not be confirmed/);
      release.resolve();
      await failed;
      const childId = requested.structured.collaboration.id;
      const worker = { slug: "scout", id: requested.structured.worker.id };
      assert.deepEqual(stops, [worker, worker], "shutdown retries the failed late cancellation only once");
      assert.equal(await service.read((state) => state.tasks[childId].cleanupPending), true);
      assert.match(await service.read((state) => state.tasks[childId].cleanupError), /Worker control cleanup unavailable/);
      await assert.rejects(service.change((state) => { state.tasks[childId].state = "requested"; }), /storage is closed/);
      cleanupAvailable = true;
      await service.stop({ requireConfirmed: true });
      assert.equal(await service.read((state) => state.tasks[childId].cleanupPending), false);
      assert.equal(await service.read((state) => state.tasks[childId].cleanupError), "");
      await service.stop({ requireConfirmed: true });
      assert.deepEqual(stops, [worker, worker, worker]);
      assert.equal(fixture.requests.length, 1);
    } finally { cleanupAvailable = true; release.resolve(); await service.stop(); }
  });
});

test("shutdown retains group participant ownership until a cancelled raw write settles", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Desk", participantSlugs: ["scout", "editor"] });
    const release = Promise.withResolvers();
    const signal = new AbortController();
    let started = false;
    const groups = createGroupExecution({ directory: home, setupTimeoutMs: 20,
      coworkerFor: fixtureCoworker,
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
    const selected = { providerId: "fixture", modelId: "publisher/compact", variant: "low" };
    const seenModels = [];
    let polls = 0;
    const service = createCollaboration({ directory: home, pollMs: 5, consult: async () => {}, spawn: async () => {}, cancelWorker: async () => {}, clientFor: async (slug, options) => {
      seenModels.push(options.model);
      const client = await fixture.clientFor(slug);
      return { ...client, resolvedModel: selected, waitForThread: async (...args) => {
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
       assert.deepEqual(fixture.requests[0].model, selected);
       assert.equal(fixture.requests[0].tools, undefined, "native dispatch never sends a v1 tool mask");
        const admitted = await service.read((state) => state.executions[entry.id]);
        assert.equal(fixture.requests[0].agent, nativeTurnAgent({ tools: admitted.tools }));
        assert.equal(admitted.agent, fixture.requests[0].agent);
        assert.equal(admitted.tools.coworker_computer_act, false, "legacy mask provenance remains on disk");
        assert.equal(admitted.tools.coworker_event_create, false, "automatic turns retain their Event write deny");
       assert.deepEqual((await service.read((state) => state.executions[entry.id])).model, selected, "native model selection is pinned at admission");
       const explicit = { providerId: "fixture", modelId: "publisher/fixed" };
       const next = await service.submit({ owner: { slug: "scout", threadId: "ses_explicit", conversationId: "ses_explicit", kind: "private" }, prompt: "Keep this exact model", model: explicit });
       await eventually(async () => (await service.read((state) => state.executions[next.id])).state === "succeeded");
       assert.deepEqual(seenModels.at(-1), explicit, "native preparation receives the already-selected override");
       assert.deepEqual(fixture.requests.at(-1).model, explicit, "a default never replaces an explicit model");
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
      const first = await service.request(trusted, "consultation", consultation, fixtureIdentity);
      const duplicate = await service.request(trusted, "consultation", consultation, fixtureIdentity);
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
      publish: (task) => task.groupId ? publishFixture(home, task) : undefined,
    });
    groups = createGroupExecution({ directory: home, collaboration: service, coworkerFor: fixtureCoworker, clientFor: fixture.clientFor });
    try {
      const owner = { ...fixtureIdentity, slug: "scout", threadId: "ses_private", conversationId: "ses_private", kind: "private" };
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
      const items = await service.listActivity();
      assert.equal(items.length, 2, "one consultation publication and one final private follow-up");
      assert.ok(items.every((item) => item.coworkerCreatedAt === fixtureCreatedAt));
      assert.deepEqual(items.find((item) => item.slug === "editor").target, { kind: "group", groupId: group.id, eventId: events.find((event) => event.slug === "editor").id });
      assert.deepEqual(items.find((item) => item.slug === "scout").target, { kind: "private", threadId: "ses_private" });
      assert.ok((await service.excludedThreads("editor")).includes(question.threadId));
      await assert.rejects(service.registerOwner({ slug: "editor", threadId: question.threadId, conversationId: question.threadId, kind: "private" }), /another conversation/);
    } finally { await groups.stop(); await service.stop(); }
  });
});

test("one thinking brief permits a bounded delivery handoff, and unavailable Workers return a failure to the origin", async () => {
  await withHome(async (home) => {
    let service;
    const spawned = [];
    const selections = [];
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
    service = createCollaboration({ directory: home, clientFor: async (slug, options) => { selections.push(options); return fixture.clientFor(slug); }, pollMs: 5, cancelWorker: async () => {},
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
      assert.ok(selections.some((selection) => selection.kind === "review" && selection.requestText === manual.goal), "form-created Worker reviews carry their goal to native model resolution");
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
      await service.stop({ requireConfirmed: true });
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
      assert.equal(await service.read((state) => state.tasks[child.structured.collaboration.id].cleanupPending), true);
      cleanupFails = false;
      await service.cancel(next.id);
      assert.equal(await service.read((state) => state.tasks[child.structured.collaboration.id].cleanupPending), false);
      assert.deepEqual(stopped, [child.structured.worker.id, child.structured.worker.id], "repeat Stop repairs cleanup even after the collaboration is terminal");
      await service.completeWorker({ id: child.structured.worker.id, slug: "scout", status: "finished" }, [{ kind: "finding", text: "LATE RESULT" }]);
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal((await service.receipts({ slug: "scout", threadId: "ses_cancel" }))[0].state, "cancelled");
      assert.equal(fixture.requests.some((request) => request.threadId === "ses_cancel" && request.prompt.includes("LATE RESULT")), false);
      await service.stop({ requireConfirmed: true });
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

test("quiet reaction-only group replies publish hidden receipts and settle the rail without Activity", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture(async ({ threadId, reply }) => {
      Object.assign(reply.parts[0], { tool: "coworker_react", toolStatus: "completed" });
      fixture.held.add(threadId);
      return "";
    });
    const clientFor = async (slug) => {
      const client = await fixture.clientFor(slug);
      const normalized = (snapshot) => {
        const settled = snapshot.status.type === "idle" && !fixture.held.has(snapshot.threadId);
        const messages = snapshot.messages.map((message) => message.role === "assistant" && !settled ? { ...message, completedAt: null } : message);
        const turnOutcomes = Object.fromEntries(messages.filter((message) => settled && message.role === "assistant" && message.completedAt != null && !message.error
          && messages.some((parent) => parent.role === "user" && parent.id === message.parentId)).map((message) => [message.parentId, "succeeded"]));
        return { ...snapshot, messages, native: { engine: "v2", pendingInputIds: [], ambiguousTurns: [], turnOutcomes } };
      };
      return { ...client,
        getThreadSnapshot: async (...args) => normalized(await client.getThreadSnapshot(...args)),
        waitForThread: async (...args) => { const result = await client.waitForThread(...args); return { ...result, snapshot: normalized(result.snapshot) }; },
      };
    };
    const service = createCollaboration({ directory: home, clientFor, pollMs: 5 });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor, coworkerFor: fixtureCoworker,
      coordinator: async () => ({}), catalogFor: async () => ({ models: [] }), pollMs: 5 });
    try {
      const group = await createGroup(home, { name: "Quiet reply", participantSlugs: ["scout", "editor"] });
      await groups.start();
      await groups.submit(group.id, { clientMessageId: "quiet-reaction", text: "@scout Thanks!" });
      await eventually(async () => (await service.activityEntries({ groupId: group.id })).some((entry) => entry.state === "running") && fixture.held.size === 1);
      const writing = await groups.activity(group.id, (scope) => service.activityEntries(scope));
      assert.equal(writing.executions.length, 1);
      fixture.held.clear();
      await eventually(async () => !(await groups.status(group.id)).active);

      const entry = await service.read((state) => state.executions[writing.executions[0].executionId]);
      assert.equal(entry.state, "succeeded");
      assert.equal(entry.reactionOnly, true);
      assert.equal(entry.error, "");
      assert.equal(entry.groupReply.published, true);
      assert.equal(await service.read((state) => state.tasks[entry.taskId].state), "succeeded");
      assert.equal(await service.read((state) => state.tasks[entry.taskId].activityEligible), true);
      const turn = (await getGroup(home, group.id)).turns[0];
      assert.equal(turn.status, "succeeded");
      assert.deepEqual(turn.speakers.map((speaker) => [speaker.status, speaker.error]), [["passed", ""]]);
      const settled = await groups.activity(group.id, (scope) => service.activityEntries(scope));
      assert.deepEqual(settled.timeline.map((event) => [event.kind, event.status, event.text]), [["user", undefined, "@scout Thanks!"], ["status", "reacted", ""]]);
      assert.equal(settled.timeline[1].executionId, entry.id);
      assert.equal(settled.timeline[1].turnId, turn.id);
      assert.deepEqual(settled.executions, []);
      const view = reconcileGroupActivity(writing, settled);
      assert.deepEqual(view.executions, []);
      assert.deepEqual(groupConversationRows(view.timeline, view.executions, []), [{ event: settled.timeline[0] }]);
      assert.deepEqual(describeGroupPresentation({ events: view.timeline, executions: view.executions, ...await groups.status(group.id), nameFor: (slug) => slug === "scout" ? "Scout" : "Editor" }), { line: "Scout reacted", activeSlugs: [] });
      assert.deepEqual(await service.listActivity(), []);
      assert.deepEqual(fixture.aborted, []);
      assert.equal(fixture.requests.length, 1);
    } finally { await groups.stop(); await service.stop(); }
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
      const editorExecution = (await service.activityEntries({ groupId: group.id })).find((entry) => entry.messageId === editor.messageId);
      assert.ok(editorExecution);
      const documents = await Promise.all([1, 2].map((revision) => appendGroupEvent(home, group.id, {
        id: `evt_document_brief_${revision}`, kind: "status", status: "document", documentId: "brief", revision,
        executionId: editorExecution.executionId, threadId: editor.threadId, text: `Editor updated Brief · revision ${revision}`,
      })));
      const writing = await groups.activity(group.id, (scope) => service.activityEntries(scope));
      assert.ok(writing.executions.some((entry) => entry.messageId === editor.messageId && entry.state === "running"), "document receipts must not hide a live native reply");
      assert.deepEqual(writing.timeline.filter((event) => event.status === "document"), documents);
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
      assert.deepEqual(handedOff.timeline.filter((event) => event.status === "document"), documents, "Stop and publication retain artifact execution provenance");
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
    service = createCollaboration({ directory: home, pollMs: 5, publishExecution: (entry) => publishFixture(home, entry), spawn: async (_slug, input) => ({ id: input.id, status: "running" }), cancelWorker: async () => {}, clientFor: async (slug, options = {}) => {
      setups.push({ slug, ...options });
      if (holdSetup && options.kind === "review") { preparing = true; await setupGate; }
      return fixture.clientFor(slug);
    } });
    const groups = createGroupExecution({ directory: home, collaboration: service, clientFor: fixture.clientFor, pollMs: 5,
      coworkerFor: async (slug) => ({ ...await fixtureCoworker(slug), role: "Research and architecture", mission: "Deep analysis", model: "test/model" }),
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
      await eventually(async () => {
        const parent = await service.read((state) => state.tasks[state.tasks[child.structured.collaboration.id].parentId]);
        return (await service.listActivity()).some((item) => item.target.eventId === `evt_${parent.executionId}`);
      });
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

test("private Continue uses a new admission with or without tools and fences the old dependency generation", async () => {
  await withHome(async (home) => {
    let effects = 0;
    let service;
    let child;
    let retries = 0;
    const nativeOutcomes = {};
    const fixture = nativeFixture(async ({ input, reply, threadId }) => {
      nativeOutcomes[input.messageId] = "succeeded";
      if (["failed", "interrupted"].includes(input.prompt)) {
        nativeOutcomes[input.messageId] = input.prompt;
        reply.parts = [];
        reply.error = { message: input.prompt };
        return;
      }
      if (input.prompt !== "Write once then fail") return;
      effects++;
      await writeFile(path.join(home, "effect.txt"), String(effects));
      const trusted = await service.context("scout", { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
      child = await service.request(trusted, "worker", { name: "Old generation", goal: "Check", continuation: { objective: "Finish the receipt", refs: ["effect.txt"], completedActions: ["Wrote effect.txt once"], resumeInstructions: "Read the receipt without writing again." } });
      reply.error = { message: "Interrupted after writing" };
      nativeOutcomes[input.messageId] = "interrupted";
    });
    const options = { directory: home, clientFor: async (slug) => {
      const client = await fixture.clientFor(slug);
      return { ...client,
        getThreadSnapshot: async (...args) => ({ ...await client.getThreadSnapshot(...args), native: { engine: "v2", turnOutcomes: { ...nativeOutcomes } } }),
        waitForThread: async (...args) => { const result = await client.waitForThread(...args); return { ...result, snapshot: { ...result.snapshot, native: { engine: "v2", turnOutcomes: { ...nativeOutcomes } } } }; },
        retryTurn: async () => { retries++; throw new Error("continuation_required"); },
      };
    }, pollMs: 5, cancelWorker: async () => {} };
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
      for (const outcome of ["failed", "interrupted"]) {
        const threadId = `ses_without_tools_${outcome}`;
        const prior = await service.submit({ owner: { slug: "scout", threadId, conversationId: threadId, kind: "private" }, messageId: `msg_${outcome}`, prompt: outcome, track: true });
        await eventually(async () => (await service.read((state) => state.executions[prior.id])).state === "failed" && fixture.aborted.includes(threadId));
        const original = structuredClone(fixture.histories.get(threadId));
        assert.equal(original.some((message) => message.parts.some((part) => part.type === "tool")), false);
        await assert.rejects(service.submit({ ...prior, retry: true }), /Choose Continue/);
        const continued = await service.submit({ ...prior, retry: true, retryByPerson: true });
        assert.notEqual(continued.messageId, prior.messageId);
        assert.equal(continued.owner.threadId, threadId);
        assert.equal((await service.submit({ ...prior, retry: true, retryByPerson: true })).id, continued.id);
        await eventually(async () => (await service.read((state) => state.executions[continued.id])).state === "succeeded");
        assert.deepEqual(fixture.histories.get(threadId).slice(0, original.length), original);
        assert.equal(fixture.requests.filter((request) => request.messageId === prior.messageId).length, 1, "the failed input is never replayed");
        assert.equal((await service.read((state) => state.executions[prior.id])).state, "failed");
      }
      assert.equal(retries, 0, "native Continue never falls through to retryTurn");
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
      const root = await service.submit({ owner: { ...fixtureIdentity, slug: "scout", threadId: "ses_tool_free", conversationId: "ses_tool_free", kind: "private" }, messageId: "msg_tool_free", prompt: "Reply without tools" });
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "failed" && fixture.aborted.length > 0);
      const retry = await service.submit({ ...root, retry: true, retryByPerson: true });
      assert.equal(retry.messageId, root.messageId);
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "succeeded");
      assert.equal(retries, 1);
      assert.equal(fixture.histories.get(root.owner.threadId).filter((message) => message.role === "user").length, 1);
      assert.equal(await service.read((state) => state.tasks[root.taskId].activityEligible), true, "known retry is not a legacy import");
      assert.deepEqual((await service.listActivity()).map((item) => [item.id, item.coworkerCreatedAt]), [[`activity_${root.id}`, fixtureCreatedAt]]);
      await service.submit({ ...root, retry: false });
      assert.equal((await service.listActivity()).length, 1, "same-ID replay still deduplicates the successful retry");
    } finally { await service.stop(); }
  });
});

test("legacy group recovery observes completed work and questions without model selection; cancel and expired waits reject late answers", async () => {
  await withHome(async (home) => {
    const fixture = nativeFixture();
    const owner = { slug: "scout", threadId: "ses_question", conversationId: "grp_question", groupId: "grp_question", kind: "group" };
    let clock = Date.now();
    let catalogAvailable = true;
    const options = { directory: home, clientFor: async (slug, { observationOnly } = {}) => {
      if (!observationOnly && !catalogAvailable) throw new Error("The current model catalog could not be read.");
      return fixture.clientFor(slug);
    }, pollMs: 5, now: () => clock, personTimeoutMs: 1000 };
    let service = createCollaboration(options);
    try {
      const root = await service.submit({ owner, messageId: "msg_question", prompt: "Question already admitted" });
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "succeeded");
      await service.stop();
      catalogAvailable = false;
      service = createCollaboration(options);
      await service.change((state) => {
        assert.ok(state.executions[root.id].sentAt);
        assert.equal(state.executions[root.id].model, null);
        delete state.executions[root.id].agent;
        state.executions[root.id].state = state.tasks[root.taskId].state = "running";
      });
      await service.start();
      await eventually(async () => (await service.read((state) => state.executions[root.id])).state === "succeeded");
      assert.equal((await service.read((state) => state.executions[root.id])).model, null, "recovery does not invent a model pin");
      assert.equal((await service.read((state) => state.executions[root.id])).agent, undefined, "recovery does not invent or replace an admitted role pin");
      const fresh = await service.submit({ owner, messageId: "msg_no_catalog", prompt: "New work still needs a model" });
      await eventually(async () => (await service.read((state) => state.executions[fresh.id])).state === "failed");
      assert.equal(fixture.requests.length, 1, "completed recovery never resends, and new admission still fails closed");
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
      catalogAvailable = true;
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

test("native interaction helpers fail closed on absent routes and keep permission/form replies session-scoped", async (t) => {
  let mode = "html";
  const replies = [];
  const paths = [];
  const prefix = "/workspace/workspace_a/opencode2/api/session/ses_a";
  const permission = { id: "per_fixture", sessionID: "ses_a", action: "edit", resources: ["a.md"], source: { type: "tool", messageID: "msg_assistant", id: "call_a" } };
  const form = { id: "frm_fixture", sessionID: "ses_a", title: "Choose", metadata: { kind: "question" }, fields: [{ key: "choice", type: "string", title: "Choose", options: [{ value: "approved", label: "Approve" }] }] };
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const request = new Request(input, init);
    const route = new URL(request.url).pathname;
    paths.push(route);
    assert.ok(route.startsWith(`${prefix}/`), "no v1 or location-wide fallback");
    if (request.method === "POST") { replies.push({ path: route, body: await request.json() }); return new Response(null, { status: 204 }); }
    if (mode === "html") return new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } });
    if (mode === "not-found") return Response.json({ error: "Missing route" }, { status: 404 });
    if (mode === "forbidden") return Response.json({ error: "Denied" }, { status: 403 });
    if (mode === "server-error") return new Response("Unavailable", { status: 503, headers: { "content-type": "text/html" } });
    if (route.endsWith("/form")) return mode === "form-error" ? Response.json({ error: "Unavailable" }, { status: 500 }) : Response.json({ data: [{ ...form, sessionID: mode === "foreign-form" ? "ses_private" : form.sessionID }] });
    if (route.endsWith("/permission")) return Response.json({ data: [{ ...permission, sessionID: mode === "foreign-permission" ? "ses_private" : permission.sessionID }] });
    if (route.endsWith(`/permission/${permission.id}`)) return Response.json({ data: permission });
    if (route.endsWith(`/form/${form.id}`)) return Response.json({ data: form });
    throw new Error(`Unexpected fixture route: ${route}`);
  });
  const threads = createCoworkerThreads({ serverUrl: "http://127.0.0.1:1", workspaceId: "workspace_a", token: "fixture" });
  for (const [state, code, status] of [["html", "invalid_response", 200], ["not-found", "request_failed", 404], ["forbidden", "request_failed", 403], ["server-error", "request_failed", 503], ["form-error", "request_failed", 500], ["foreign-permission", "invalid_response", null], ["foreign-form", "invalid_response", null]]) {
    mode = state;
    await assert.rejects(threads.listThreadInteractions("ses_a"), { code, status });
  }
  assert.deepEqual(replies, []);
  mode = "json";
  const native = await threads.listThreadInteractions("ses_a");
  assert.deepEqual(native.permissions.map((request) => request.id), [permission.id]);
  assert.deepEqual(native.permissions[0].tool, { messageID: "msg_assistant", callID: "call_a" });
  assert.deepEqual(native.questions.map((question) => question.id), [form.id]);
  await threads.replyPermission(native.permissions[0], "once");
  await threads.replyQuestion(native.questions[0], [["Approve"]]);
  assert.deepEqual(replies, [
    { path: `${prefix}/permission/${permission.id}/reply`, body: { reply: "once" } },
    { path: `${prefix}/form/${form.id}/reply`, body: { answer: { choice: "approved" } } },
  ]);
  permission.resources = ["changed.md"];
  await assert.rejects(threads.replyPermission(native.permissions[0], "once"), /Permission changed/);
  await assert.rejects(threads.replyPermission({ ...native.permissions[0], sessionID: "ses_private" }, "once"), /exact native permission/);
  assert.equal(replies.length, 2, "stale and cross-session replies never dispatch");
  assert.ok(paths.every((route) => route.startsWith(`${prefix}/`)));
});

test("a nested consultation delivers the final child continuation to its parent once", async () => {
  await withHome(async (home) => {
    let service;
    const published = [];
    const selections = [];
    const fixture = nativeFixture(async ({ slug, threadId, input, reply }) => {
      if (input.prompt === "Private task" || input.prompt === "Focused B question") {
        const trusted = await service.context(slug, { sessionID: threadId, messageID: reply.id, callID: reply.parts[0].callId });
        await service.request(trusted, "consultation", { to: slug === "scout" ? "editor" : "ops", question: slug === "scout" ? "Focused B question" : "Focused C question", continuation: { objective: input.prompt, resumeInstructions: "Synthesize the requested answer." } }, fixtureIdentity);
        reply.parts.push({ type: "text", text: "ACKNOWLEDGEMENT ONLY" });
      } else if (slug === "editor") reply.parts.push({ type: "text", text: "FINAL B SYNTHESIS" });
    });
    service = createCollaboration({ directory: home, clientFor: async (slug, options) => { selections.push({ slug, ...options }); return fixture.clientFor(slug); }, pollMs: 5,
      consult: async (task) => ({ owner: { slug: task.to, threadId: `ses_${task.to}`, conversationId: "grp_nested00", groupId: "grp_nested00", kind: "consultation" }, prompt: task.input.question }),
      publish: async (task) => { published.push({ id: task.id, result: task.result }); return publishFixture(home, task); },
    });
    try {
      const root = await service.submit({ owner: { ...fixtureIdentity, slug: "scout", threadId: "ses_private", conversationId: "ses_private", kind: "private" }, messageId: "msg_nested", prompt: "Private task" });
      await eventually(async () => (await service.read((state) => state.tasks[root.taskId])).state === "succeeded");
      const final = fixture.requests.filter((request) => request.threadId === "ses_private" && request.prompt.startsWith("Continue the original task"));
      assert.equal(final.length, 1);
      assert.match(final[0].prompt, /FINAL B SYNTHESIS/);
      assert.doesNotMatch(final[0].prompt, /ACKNOWLEDGEMENT ONLY/);
      assert.equal(fixture.requests.filter((request) => request.slug === "editor" && request.prompt.startsWith("Continue the original task")).length, 1);
      for (const kind of ["reply", "review"]) assert.equal(selections.find((selection) => selection.slug === "editor" && selection.kind === kind).requestText, "Focused B question", "new consultations and their reviews retain the question, not the continuation wrapper");
      assert.equal(new Set(published.map((entry) => entry.id)).size, 2);
      assert.equal(published.length, 2);
      const items = await service.listActivity();
      assert.equal(items.length, 3, "nested publications and the private origin are captured once each");
      assert.equal(items.filter((item) => item.slug === "editor").length, 1, "consultation continuation publication is not counted twice");
      assert.ok(items.every((item) => item.coworkerCreatedAt === fixtureCreatedAt), "nested consultation continuations inherit the pinned target identity");
      assert.match(items.find((item) => item.slug === "editor").preview, /FINAL B SYNTHESIS/);
      assert.ok(items.every((item) => !item.preview.includes("ACKNOWLEDGEMENT ONLY")));
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
      publish: async (task) => { attempts++; if (!available) throw new Error("Local projection failed"); return publishFixture(home, task); },
    });
    try {
      const root = await service.submit({ owner: { slug: "scout", threadId: "ses_origin", conversationId: "ses_origin", kind: "private" }, messageId: "msg_projection", prompt: "Original task" });
      await service.request({ entry: root, callId: "projection" }, "consultation", { to: "editor", question: "Focused question" });
      await eventually(async () => (await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].state === "failed");
      assert.equal(attempts, 3);
      assert.match((await service.receipts({ slug: "scout", threadId: "ses_origin" }))[0].error, /three attempts|could not be shown/);
      assert.equal(fixture.requests.filter((request) => request.prompt.startsWith("Continue the original task")).length, 0);
      assert.deepEqual(await service.listActivity(), [], "an unpublished reply has no Activity row");
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
    const groupOptions = { directory: home, clientFor: fixture.clientFor, pollMs: 5, coworkerFor: fixtureCoworker };
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
      const inboxBeforeReplay = await service.markActivityRead((await service.listActivity()).map((item) => item.id));
      assert.equal(inboxBeforeReplay.length, 1);
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
        assert.deepEqual(await service.listActivity(), inboxBeforeReplay, "publication replay does not reset readAt or duplicate Activity");
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
      settings: async () => normalizeSettings({ modelDefaults: { facilitator: { model: selection.id === "single" ? "test/model" : "", modelVariant: "high" } } }),
      catalogFor: async () => ({ models: [{ id: "test/model", providerId: "test", modelId: "model", variants: ["high", "minimal", "low"], source: "local", tier: "key", toolCall: true, status: "active", label: "Test", releaseDate: "" }] }),
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
        assert.equal(fixture.requests.slice(before).find((entry) => entry.slug === ".coordinator").model.variant, scenario.id === "single" ? "high" : "minimal", "next-turn settings use exact explicit effort, otherwise minimal regardless of catalog order");
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

const eventOutcome = { summary: "Reviewed the evidence and recorded the remaining question.", decisions: ["Keep the current plan."], accomplishments: ["Reviewed both contributions."], openQuestions: ["Who approves the next step?"], followUps: ["Ask the person before executing the proposal."] };
function eventInput(slugs = ["scout", "editor"]) {
  const startsAt = Date.now() - 1000;
  return { title: "Evidence review", description: "", template: "working-session", state: "active", artifacts: [], objective: "Review current evidence, do not execute proposals.", leadSlug: slugs[0], participantSlugs: slugs,
    startsAt, schedule: { kind: "once", at: startsAt, timezone: "Etc/UTC" }, durationMinutes: 5, maxReplies: slugs.length + 1 };
}

async function eventFixture(home, options = {}) {
  let services;
  const members = options.members ?? Object.fromEntries(["scout", "editor"].map((slug) => [slug, { slug, name: slug, role: "Reviewer", mission: "Review evidence", model: "test/model", path: path.join(home, slug), createdAt: "2026-09-10T00:00:00.000Z", workspaceId: `workspace_${slug}` }]));
  const native = options.native ?? nativeFixture(async ({ slug, threadId, input, reply }) => {
    const service = services.current;
    if (!options.noConclusion && input.prompt.includes("Phase: conclusion")) {
      const args = { outcome: eventOutcome };
      const callID = `conclude_${reply.id}`;
      reply.parts.push({ type: "tool", tool: "coworker_event_conclude", toolStatus: "running", callId: callID, toolInput: args });
      await service.events.executeNative(slug, { name: "event_conclude", args, context: { sessionID: threadId, messageID: reply.id, callID, directory: path.join(home, slug) } });
      reply.parts.at(-1).toolStatus = "completed";
    }
    await options.onSend?.({ ...service, slug, threadId, input, reply, native });
  });
  services = options.services ?? { current: null };
  const clientFor = async (slug, request = {}) => {
    const client = await native.clientFor(slug, request);
    return { ...client, ...(members[slug] ? { coworkerIdentity: coworkerIdentity(members[slug]), coworkerCreatedAt: members[slug].createdAt } : {}), ...(options.resolveModel ? { resolvedModel: options.resolveModel(slug, request) } : {}), getThreadSnapshot: async (...args) => ({ ...await client.getThreadSnapshot(...args), directory: path.join(home, slug) }) };
  };
  let events;
  let groups;
  const collaboration = createCollaboration({ directory: home, clientFor, pollMs: 5, setupTimeoutMs: options.setupTimeoutMs ?? 30_000,
    validateOwner: (owner) => events.validateOwner(owner), consult: (task) => groups.consultation(task),
    spawn: options.spawn ?? (async (_slug, input) => ({ id: input.id, status: "running" })), cancelWorker: async () => {},
    onExecutionEnd: async (entry, snapshot) => { await options.onExecutionEnd?.(entry, snapshot); await events.captureExecution(entry, snapshot); },
    memoryContext: options.memoryContext,
    executionContext: (owner) => events.context(owner),
    publish: (task) => publishFixture(home, task),
    publishExecution: (entry) => entry.owner.groupId ? publishFixture(home, entry) : undefined,
  });
  groups = createGroupExecution({ directory: home, collaboration, clientFor, coworkerFor: async (slug) => {
    if (!members[slug]) throw new Error("Coworker not found."); return members[slug];
  }, eventContext: (request, slug) => events.requestContext(request, slug), conversationContext: (groupId, expected) => events.conversationContext(groupId, expected),
    coordinator: options.coordinator, catalogFor: options.catalogFor, settings: options.settings, onPublished: options.onPublished, pollMs: 5 });
  events = createEvents({ directory: home, collaboration, groups, coworkerFor: async (slug) => { if (!members[slug]) throw new Error("Coworker not found."); return members[slug]; }, coworkers: async () => Object.values(members),
    resolveContext: async (slug, context, expected) => {
      const trusted = await collaboration.context(slug, context, expected, assertEventToolContext);
      await options.onContextResolved?.(slug, expected, trusted);
      return trusted;
    },
    readArtifact: options.readArtifact ?? (async () => { throw new Error("No artifact fixture."); }),
    readExecution: async (entry) => (await clientFor(entry.owner.slug, { model: entry.model, observationOnly: true })).getThreadSnapshot(entry.owner.threadId),
    now: options.now,
  });
  const current = { events, groups, collaboration, native, members, services,
    stop: async () => { await events.stop(); await groups.stop(); await collaboration.stop(); },
    settle: async (id) => {
      await eventually(async () => { await events.tick(); const { runs } = await events.get(id); return runs.length > 0 && runs.every((run) => !["queued", "running", "waiting"].includes(run.status)); });
      return (await events.get(id)).runs;
    },
  };
  services.current = current;
  await events.start();
  if (options.startGroups !== false) { await groups.start(); await collaboration.start(); }
  return current;
}

async function eventCall(source, name, args, callID = `${name}_${source.reply.id}`) {
  let part = source.reply.parts.find((part) => part.callId === callID);
  if (!part) { part = { type: "tool", callId: callID }; source.reply.parts.push(part); }
  Object.assign(part, { tool: `coworker_${name}`, toolStatus: "running", toolInput: args });
  try {
    return JSON.parse((await source.events.executeNative(source.slug, { name, args, context: {
      sessionID: source.threadId, messageID: source.reply.id, callID, directory: source.members[source.slug].path,
    } })).text);
  } finally { part.toolStatus = "completed"; }
}

test("Event reminders use saved once daily weekly slots without native work and survive read restart and pruning", async (t) => {
  await withHome(async (home) => {
    const startsAt = Date.UTC(2026, 8, 14, 9);
    let clock = startsAt - EVENT_REMINDER_LEAD_MS - 1;
    let service = await eventFixture(home, { startGroups: false, now: () => clock });
    const inbox = () => createActivityInbox({ collaboration: service.collaboration, coworkers: async () => Object.values(service.members), groups: () => listGroups(home), now: () => clock });
    try {
      const definitions = [];
      for (const schedule of [
        { kind: "once", at: startsAt, timezone: "Etc/UTC" },
        { kind: "daily", hour: 9, minute: 0, timezone: "Etc/UTC" },
        { kind: "weekly", daysOfWeek: [1], hour: 9, minute: 0, timezone: "Etc/UTC" },
      ]) definitions.push(await service.events.create({ ...eventInput(["scout"]), startsAt, schedule }));
      await service.events.tick();
      assert.deepEqual(await inbox().list(), []);
      clock++;
      await Promise.all([service.events.tick(), service.events.tick()]);
      const reminders = await inbox().list();
      assert.equal(reminders.length, 3);
      assert.ok(reminders.every((item) => item.kind === "event-reminder" && item.readAt === null && item.target.scheduledFor === startsAt && item.at === clock));
      assert.ok(reminders.every((item) => Object.keys(item).sort().join() === "at,id,kind,preview,readAt,target,title"));
      assert.ok((await service.events.list()).every((event) => !Object.hasOwn(event, "activityReminder")));
      for (const event of definitions) assert.equal((await service.events.get(event.id)).runs.length, 0);
      const raw = await service.collaboration.listActivity();
      assert.equal(raw[0].identities.scout.path, service.members.scout.path);
      assert.equal(service.native.requests.length, 0);
      const read = await inbox().markRead(reminders.map((item) => item.id));
      assert.ok(read.every((item) => typeof item.readAt === "number"));
      const clone = globalThis.structuredClone;
      let storeCopies = 0;
      const spy = t.mock.method(globalThis, "structuredClone", (value) => { if (value?.tasks) storeCopies++; return clone(value); });
      try { await service.events.tick(); assert.equal(storeCopies, 0, "an already recorded future reminder leaves idle history untouched"); }
      finally { spy.mock.restore(); }
      const { native, members, services } = service;
      await service.stop();
      clock += 60_000;
      service = await eventFixture(home, { native, members, services, startGroups: false, now: () => clock });
      await service.events.tick();
      assert.deepEqual(await inbox().list(), read);
      const unread = await inbox().markRead([read[0].id], false);
      assert.equal(unread.find((item) => item.id === read[0].id).readAt, null);
      assert.deepEqual(await inbox().list(), unread, "observing Upcoming or Activity does not acknowledge a notification");
      await service.collaboration.change((state) => {
        for (let index = 0; index < MAX_ACTIVITY_ITEMS; index++) {
          const id = `reminder_prune_${index}`;
          const owner = { slug: "scout", kind: "private", threadId: "private", conversationId: "private" };
          state.tasks[id] = { id, owner, state: "succeeded", executionId: id, activityEligible: true };
          const entry = state.executions[id] = { ...fixtureIdentity, id, taskId: id, owner, state: "succeeded", workspaceId: "workspace_scout" };
          recordActivity(state, entry, { text: "Visible result", at: clock + index });
        }
      });
      const bounded = await service.collaboration.listActivity();
      assert.equal(bounded.length, MAX_ACTIVITY_ITEMS);
      assert.ok(bounded.every((item) => item.kind === "reply"));
      await service.stop();
      service = await eventFixture(home, { native, members, services, startGroups: false, now: () => clock });
      await Promise.all([service.events.tick(), service.events.tick()]);
      assert.deepEqual(await service.collaboration.listActivity(), bounded, "pruned reminders retain their native receipt across restart");
      assert.equal(native.requests.length, 0);
    } finally { await service.stop(); }
  });
});

test("Event reminders update same-slot copy and invalidate reschedules state and roster without consuming manual runs", async () => {
  await withHome(async (home) => {
    let clock = Date.UTC(2026, 8, 14, 8, 55);
    const service = await eventFixture(home, { startGroups: false, now: () => clock });
    const inbox = createActivityInbox({ collaboration: service.collaboration, coworkers: async () => Object.values(service.members), groups: () => listGroups(home), now: () => clock });
    const startsAt = clock + 5 * 60_000;
    let event = await service.events.create({ ...eventInput(["scout"]), startsAt, schedule: { kind: "once", at: startsAt, timezone: "Etc/UTC" } });
    const update = async (patch) => { event = await service.events.update(event.id, { ...eventInputSchema.parse(event), ...patch }, event.revision); };
    try {
      await service.events.tick();
      const [original] = await inbox.list();
      const [read] = await inbox.markRead([original.id]);
      clock += 1000;
      await update({ title: "Renamed review" });
      const [renamed] = await inbox.list();
      assert.deepEqual({ ...renamed, title: read.title, preview: read.preview }, read);
      assert.equal(renamed.title, "Renamed review");
      assert.match(renamed.preview, /Renamed review/);
      const later = startsAt + 60_000;
      await update({ startsAt: later, schedule: { ...event.schedule, at: later } });
      assert.deepEqual(await service.collaboration.listActivity(), [], "the old reminder disappears in the schedule transaction");
      await service.events.tick();
      const [rescheduled] = await inbox.list();
      assert.notEqual(rescheduled.id, original.id);
      assert.equal(rescheduled.readAt, null);
      await inbox.markRead([original.id]);
      assert.equal((await inbox.list())[0].readAt, null, "a delayed old acknowledgement cannot mark the replacement");
      await update({ startsAt, schedule: { ...event.schedule, at: startsAt } });
      await service.events.tick();
      assert.notEqual((await inbox.list())[0].id, original.id, "returning to the old time uses a new generation");
      await update({ state: "paused" });
      assert.deepEqual(await service.collaboration.listActivity(), []);
      await service.events.tick();
      assert.deepEqual(await inbox.list(), []);
      await update({ state: "active" });
      await service.events.tick();
      await update({ participantSlugs: ["scout", "editor"], maxReplies: 3 });
      assert.deepEqual(await service.collaboration.listActivity(), []);
      await service.events.tick();
      const [roster] = await inbox.list();
      assert.deepEqual(Object.keys((await service.collaboration.listActivity())[0].identities).sort(), ["editor", "scout"]);
      const manual = await service.events.runNow(event.id, "manual-before-schedule");
      const cancelled = await service.events.cancel(event.id, manual.id);
      assert.equal(cancelled.status, "cancelled");
      assert.equal(cancelled.stopping, false);
      assert.equal(Object.hasOwn(cancelled.event, "activityReminder"), false);
      await service.events.tick();
      assert.deepEqual(await inbox.list(), [roster], "manual cancellation leaves the future scheduled reminder alone");
      const beforeRead = await service.collaboration.listActivity();
      clock = startsAt;
      assert.deepEqual(await inbox.list(), [], "an expired reminder is hidden even before the next tick");
      assert.deepEqual(await service.collaboration.listActivity(), beforeRead, "list remains side-effect free");
      await service.events.tick();
      assert.deepEqual(await service.collaboration.listActivity(), []);
      const scheduled = (await service.events.get(event.id)).runs.find((run) => run.trigger !== "manual");
      assert.equal(scheduled.scheduledFor, startsAt);
      await service.events.cancel(event.id, scheduled.id);
      assert.equal(service.native.requests.length, 0);
      const future = clock + 60_000;
      await update({ startsAt: future, schedule: { ...event.schedule, at: future } });
      await service.events.tick();
      await update({ state: "archived" });
      assert.deepEqual(await service.collaboration.listActivity(), []);
    } finally { await service.stop(); }
  });
});

test("Event reminders keep identity pins private and reject recycled missing archived or mismatched participants", async () => {
  await withHome(async (home) => {
    const clock = Date.UTC(2026, 8, 14, 8, 55);
    const service = await eventFixture(home, { startGroups: false, now: () => clock });
    let memberships;
    const inbox = createActivityInbox({ collaboration: service.collaboration, coworkers: async () => Object.values(service.members), groups: async () => memberships, now: () => clock });
    try {
      const startsAt = clock + 60_000;
      await service.events.create({ ...eventInput(), startsAt, schedule: { kind: "once", at: startsAt, timezone: "Etc/UTC" } });
      memberships = await listGroups(home);
      await service.events.tick();
      const [item] = await inbox.list();
      const original = service.members.editor;
      for (const patch of [{ createdAt: "replacement" }, { workspaceId: "replacement" }, { path: path.join(home, "replacement") }]) {
        service.members.editor = { ...original, ...patch };
        assert.deepEqual(await inbox.list(), []);
        assert.deepEqual(await inbox.markRead([item.id]), []);
        assert.equal((await service.collaboration.listActivity())[0].readAt, null);
      }
      delete service.members.editor;
      assert.deepEqual(await inbox.list(), []);
      service.members.editor = original;
      const groups = memberships;
      for (const patch of [{ archivedAt: clock }, { participantSlugs: ["scout"] }, { eventId: undefined }]) {
        memberships = groups.map((group) => ({ ...group, ...patch }));
        assert.deepEqual(await inbox.list(), []);
      }
      memberships = [];
      assert.deepEqual(await inbox.list(), []);
      memberships = groups.map((group) => ({ ...group, eventId: "another-shared-rhythm" }));
      assert.deepEqual(await inbox.list(), [item], "shared All Hands groups need not point to this specific definition");
      await service.collaboration.change((state) => { state.activity[0].identities.editor.unresolved = true; });
      assert.deepEqual(await inbox.list(), []);
      assert.equal(service.native.requests.length, 0);
    } finally { await service.stop(); }
  });
});

test("Event reminders skip already claimed manual-only and expired plans and admit late future reminders", async () => {
  await withHome(async (home) => {
    let clock = Date.UTC(2026, 8, 14, 8, 55);
    let service = await eventFixture(home, { startGroups: false, now: () => clock });
    try {
      const startsAt = clock + 60_000;
      const input = { ...eventInput(["scout"]), startsAt, schedule: { kind: "once", at: startsAt, timezone: "Etc/UTC" } };
      const claimed = await service.events.create(input);
      const run = await service.events.runNow(claimed.id, "accepted-slot");
      await service.events.cancel(claimed.id, run.id);
      const manual = await service.events.create(input);
      const past = await service.events.create({ ...input, startsAt: clock - 1, schedule: { ...input.schedule, at: clock - 1 } });
      const late = await service.events.create(input);
      await service.collaboration.change((state) => {
        Object.assign(state.workplaceEvents.runs[run.id], { trigger: "recovery", scheduledFor: startsAt });
        state.workplaceEvents.definitions[manual.id].manualOnly = true;
      });
      const { native, members, services } = service;
      await service.stop();
      clock += 30_000;
      service = await eventFixture(home, { native, members, services, startGroups: false, now: () => clock });
      await service.events.tick();
      const items = await service.collaboration.listActivity();
      assert.deepEqual(items.map((item) => item.target.eventId), [late.id]);
      assert.equal((await service.events.get(past.id)).runs.length, 1, "the existing due path still claims past work, without a retrospective reminder");
      assert.equal(service.native.requests.length, 0);
    } finally { await service.stop(); }
  });
});

test("Event reminders cannot block due source work when the optional projection write fails", async (t) => {
  await withHome(async (home) => {
    const clock = Date.UTC(2026, 8, 14, 8, 55);
    const service = await eventFixture(home, { startGroups: false, now: () => clock });
    try {
      const create = (startsAt) => service.events.create({ ...eventInput(["scout"]), startsAt, schedule: { kind: "once", at: startsAt, timezone: "Etc/UTC" } });
      const upcoming = await create(clock + 60_000);
      const due = await create(clock - 1);
      const change = service.collaboration.change;
      let failed = false;
      const spy = t.mock.method(service.collaboration, "change", (fn, needed) => {
        if (!failed && needed) { failed = true; return Promise.reject(new Error("Optional reminder write unavailable")); }
        return change(fn, needed);
      });
      try { await service.events.tick(); }
      finally { spy.mock.restore(); }
      assert.equal(failed, true);
      assert.equal((await service.events.get(due.id)).runs.length, 1);
      assert.deepEqual(await service.collaboration.listActivity(), []);
      await service.events.tick();
      assert.equal((await service.collaboration.listActivity())[0].target.eventId, upcoming.id);
      assert.equal(service.native.requests.length, 0);
    } finally { await service.stop(); }
  });
});

test("event occurrences claim once, persist exact participants and accept only the lead's native conclusion", async () => {
  await withHome(async (home) => {
    let rejected = 0;
    const service = await eventFixture(home, { onSend: async ({ events, slug, threadId, input, reply }) => {
      if (!input.prompt.includes("Phase: contributions")) return;
      const args = { outcome: eventOutcome }; const callID = `spoof_${reply.id}`;
      reply.parts.push({ type: "tool", tool: "coworker_event_conclude", toolStatus: "running", callId: callID, toolInput: args });
      await assert.rejects(events.executeNative(slug, { name: "event_conclude", args, context: { sessionID: threadId, messageID: reply.id, callID, directory: path.join(home, slug) } }), /Only the admitted lead/);
      reply.parts.at(-1).toolStatus = "completed";
      rejected++;
    } });
    try {
      const event = await service.events.create(eventInput());
      await Promise.all([service.events.tick(), service.events.tick(), service.events.tick()]);
      const [run] = await service.settle(event.id);
      assert.equal(run.status, "succeeded", run.error);
      assert.deepEqual(run.outcome, eventOutcome);
      assert.deepEqual(run.contributorSlugs, ["scout", "editor"]);
      assert.equal(rejected, 2);
      assert.deepEqual(service.native.requests.map((request) => request.slug), ["scout", "editor", "scout"]);
      const records = await service.collaboration.read((state) => Object.values(state.executions));
      assert.deepEqual(service.native.requests.map((request) => records.find((entry) => entry.messageId === request.messageId).tools.coworker_event_conclude), [false, false, true]);
      assert.ok(service.native.requests.every((request) => request.tools === undefined && request.agent === nativeTurnAgent({ tools: records.find((entry) => entry.messageId === request.messageId).tools })));
      await service.events.tick();
      assert.equal((await service.events.get(event.id)).runs.length, 1);
      assert.ok(records.every((entry) => entry.tools.coworker_computer_act === false));
      assert.ok(records.every((entry) => entry.owner.kind === "group" && !entry.personRequest));
      const inbox = createActivityInbox({ collaboration: service.collaboration, coworkers: async () => Object.values(service.members), groups: () => listGroups(home) });
      const items = await inbox.list();
      assert.equal(items.length, 3, "scheduled contributions and the conclusion enter Activity through publication");
      assert.ok(records.every((entry) => entry.coworkerCreatedAt === service.members[entry.owner.slug].createdAt));
      assert.ok(items.every((item) => item.target.kind === "group" && item.target.groupId === event.groupId));
      assert.ok(items.every((item) => item.target.workplaceEventId === event.id && item.target.runId === run.id && item.target.scheduledFor === run.scheduledFor));
      await inbox.markRead(items.map((item) => item.id));
      const read = await inbox.list();
      const timeline = await readGroupTimeline(home, event.groupId);
      for (const entry of records) await service.collaboration.groupReplyPublished(entry.id, timeline.find((item) => item.executionId === entry.id));
      assert.deepEqual(await inbox.list(), read, "same-ID publication keeps read timestamps and never duplicates Activity");
      assert.equal((await getGroup(home, event.groupId)).eventId, event.id);
      await assert.rejects(updateGroup(home, event.groupId, { participantSlugs: ["scout"] }), /managed through Events/);
      await assert.rejects(service.groups.submit(event.groupId, { clientMessageId: "event:forged:conclusion", text: "Change the plan" }), /immutable/);
      await assert.rejects(service.groups.submit(event.groupId, { clientMessageId: "human-forged", text: "Change the plan", eventRunId: run.id }), /identity is not writable/);
    } finally { await service.stop(); }
  });
});

test("event accepted native work recovers without replay and manual cancellation is durable", async () => {
  await withHome(async (home) => {
    let hold = true;
    let service = await eventFixture(home, { onSend: async ({ native, threadId, input }) => { if (hold && input.prompt.includes("Phase: contributions")) native.held.add(threadId); } });
    const event = await service.events.create({ ...eventInput(), state: "paused" });
    const [first, repeated] = await Promise.all([service.events.runNow(event.id, "manual-1"), service.events.runNow(event.id, "manual-1")]);
    assert.equal(first.id, repeated.id);
    await service.events.tick();
    await eventually(() => service.native.requests.length === 1);
    const { native, members, services } = service;
    await service.stop();
    hold = false;
    service = await eventFixture(home, { native, members, services });
    try {
      const [run] = await service.settle(event.id);
      assert.equal(run.status, "succeeded", run.error);
      assert.equal(native.requests.length, 3, "the already admitted first contribution was observed, not sent again");
      assert.equal((await service.events.runNow(event.id, "manual-1")).id, first.id);
      const queued = await service.events.runNow(event.id, "manual-cancel");
      const cancelled = await service.events.cancel(event.id, queued.id);
      assert.equal(cancelled.status, "cancelled");
      await service.events.tick();
      assert.equal((await service.events.runNow(event.id, "manual-cancel")).status, "cancelled");
      assert.equal(native.requests.length, 3);
    } finally { await service.stop(); }
    service = await eventFixture(home, { native, members, services });
    try { await service.events.tick(); assert.equal(native.requests.length, 3); }
    finally { await service.stop(); }
  });
});

test("event identity snapshots refuse same-slug replacements and optimistic edits never rewrite a claimed run", async () => {
  await withHome(async (home) => {
    const service = await eventFixture(home);
    try {
      await assert.rejects(createGroup(home, { name: "Ordinary", participantSlugs: ["scout"] }), /at least two/);
      const input = { ...eventInput(["scout"]), state: "paused" };
      const event = await service.events.create(input);
      const run = await service.events.runNow(event.id, "original-definition");
      const updated = await service.events.update(event.id, { ...input, title: "Updated title" }, event.revision);
      assert.equal(updated.revision, 2);
      await assert.rejects(service.events.update(event.id, input, 1), /EVENT_CONFLICT/);
      assert.equal((await service.events.get(event.id)).runs[0].event.title, run.event.title);
      service.members.scout = { ...service.members.scout, createdAt: "2026-09-11T00:00:00.000Z" };
      await service.events.tick();
      const result = (await service.events.get(event.id)).runs[0];
      assert.equal(result.status, "failed");
      assert.match(result.error, /original identity/);
      assert.equal(service.native.requests.length, 0);
      await assert.rejects(service.events.update(event.id, input, 2), /original identity/);
    } finally { await service.stop(); }
  });
});

test("event dependencies release the group queue before final continuation and lead synthesis", async () => {
  await withHome(async (home) => {
    let child;
    const service = await eventFixture(home, { onSend: async ({ collaboration, slug, input }) => {
      if (slug !== "scout" || !input.prompt.includes("Phase: contributions")) return;
      const entry = await collaboration.read((state) => Object.values(state.executions).find((entry) => entry.messageId === input.messageId));
      const response = await collaboration.request({ entry, callId: "delegated" }, "worker", { name: "Evidence", goal: "Check the evidence", continuation: { objective: "Review evidence", resumeInstructions: "Use the result in your contribution" } });
      child = response.structured.collaboration.id;
    } });
    try {
      const event = await service.events.create({ ...eventInput(), maxReplies: 5 });
      await service.events.tick();
      await eventually(async () => child && !(await service.groups.status(event.groupId)).active);
      await service.events.tick();
      assert.equal((await service.events.get(event.id)).runs[0].phase, "waiting");
      assert.equal(service.native.requests.length, 2, "the lead has not concluded while a Worker is pending");
      await service.groups.submit(event.groupId, { clientMessageId: "progress-during-event", text: "@editor How is the evidence progressing?" });
      await eventually(async () => !(await service.groups.status(event.groupId)).active && service.native.requests.length === 3);
      const ordinary = await service.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.groupRequestId === "progress-during-event"));
      assert.equal(ordinary.owner.eventRunId, undefined);
      assert.match(ordinary.prompt, /ordinary conversation/);
      assert.match(ordinary.prompt, /"status":"waiting"/);
      const task = await service.collaboration.read((state) => state.tasks[child]);
      const worker = { id: task.workerId, slug: "scout", pendingTurn: { messageId: "worker-step-1" } };
      await service.collaboration.admitEventWorker(worker);
      await service.collaboration.admitEventWorker(worker);
      await assert.rejects(service.collaboration.admitEventWorker({ ...worker, pendingTurn: { messageId: "worker-step-2" } }), /reply budget/);
      await service.collaboration.complete(child, { state: "succeeded", result: "Evidence verified" });
      const [run] = await service.settle(event.id);
      assert.equal(run.status, "succeeded", run.error);
      assert.equal(service.native.requests.length, 5);
      assert.match(service.native.requests[3].prompt, /automatic follow-up/);
      assert.match(service.native.requests[4].prompt, /Phase: conclusion/);
      const usage = await service.collaboration.read((state) => state.workplaceEvents.runs[run.id].usage);
      assert.equal(Object.keys(usage).length, 5, "the same Worker admission costs one reply and its handback has reserved room");
      const items = await service.collaboration.listActivity();
      assert.equal(items.length, 5, "scheduled replies, the human group reply and Worker handback are published once");
      assert.ok(items.every((item) => item.coworkerCreatedAt === service.members[item.slug].createdAt));
      assert.equal(items.find((item) => item.id === `activity_${ordinary.id}`).target.workplaceEventId, undefined, "ordinary Event-group replies do not inherit a scheduled run");
    } finally { await service.stop(); }
  });
});

test("Event consultations retain the accepted recipient identity through publication and handback", async () => {
  await withHome(async (home) => {
    let childId;
    const service = await eventFixture(home, { onSend: async ({ collaboration, slug, input, reply }) => {
      const entry = await collaboration.read((state) => Object.values(state.executions).find((entry) => entry.messageId === input.messageId));
      if (entry.owner.kind === "consultation") reply.parts.push({ type: "text", text: "@you, approve the next step?" });
      if (slug !== "scout" || !input.prompt.includes("Phase: contributions")) return;
      const receipt = await collaboration.request({ entry, callId: "event-consultation" }, "consultation", { to: "editor", question: "Check this public fact", continuation: { objective: "Review evidence", resumeInstructions: "Use the answer in your contribution" } });
      childId = receipt.structured.collaboration.id;
    } });
    try {
      service.members.editor.createdAt = "2026-09-09T00:00:00.000Z";
      const event = await service.events.create({ ...eventInput(), maxReplies: 5 });
      const [run] = await service.settle(event.id);
      assert.equal(run.status, "succeeded", run.error);
      const child = await service.collaboration.read((state) => state.tasks[childId]);
      assert.equal(child.coworkerCreatedAt, service.members.editor.createdAt);
      assert.equal(child.owner.coworkerCreatedAt, child.coworkerCreatedAt);
      assert.equal(child.origin.coworkerCreatedAt, service.members.scout.createdAt);
      assert.equal(child.owner.eventRunId, run.id);
      const inbox = createActivityInbox({ collaboration: service.collaboration, coworkers: async () => Object.values(service.members), groups: () => listGroups(home) });
      const items = await inbox.list();
      assert.equal(items.length, 5);
      assert.ok(items.every((item) => item.coworkerCreatedAt === service.members[item.slug].createdAt));
      const answer = items.find((item) => item.id === `activity_${child.executionId}`);
      assert.equal(answer.kind, "mention");
      assert.equal(answer.target.groupId, event.groupId);
      assert.equal((await readGroupTimeline(home, event.groupId)).filter((item) => item.executionId === child.executionId).length, 1);
      service.members.editor = { ...service.members.editor, createdAt: "2026-09-12T00:00:00.000Z" };
      assert.ok((await inbox.list()).every((item) => item.slug !== "editor"));
    } finally { await service.stop(); }
  });
});

test("legacy All Hands migration preserves its group, disabled/manual rhythm and claimed occurrence", async () => {
  await withHome(async (home) => {
    await updateAllHands(home, { enabled: true, frequency: "twice", morning: "00:00", afternoon: "00:01" });
    const group = await prepareAllHands(home, [{ slug: "scout" }, { slug: "editor" }]);
    await appendGroupEvent(home, group.id, { kind: "user", text: "Retain this conversation" });
    const settings = await readAllHands(home);
    await writeFile(path.join(home, ".all-hands.json"), JSON.stringify({ ...settings, enabledAt: Date.now() - 86400000, lastRequestedAt: Date.now(), lastOccurrence: "reserved" }));
    let service = await eventFixture(home);
    const { native, members, services } = service;
    try {
      const events = await service.events.list();
      assert.equal(events.length, 2);
      assert.ok(events.every((event) => event.groupId === group.id && event.nextDueAt > Date.now()));
      assert.equal(await claimAllHands(home), null);
      await service.events.tick();
      assert.equal(native.requests.length, 0);
      assert.equal((await readGroupTimeline(home, group.id))[0].text, "Retain this conversation");
    } finally { await service.stop(); }
    service = await eventFixture(home, { native, members, services });
    try { assert.equal((await service.events.list()).length, 2); assert.equal(await claimAllHands(home), null); }
    finally { await service.stop(); }
  });
  await withHome(async (home) => {
    await updateAllHands(home, { enabled: true, frequency: "manual" });
    const group = await prepareAllHands(home, [{ slug: "scout" }, { slug: "editor" }]);
    await updateAllHands(home, { enabled: false });
    const service = await eventFixture(home);
    try {
      const [event] = await service.events.list();
      assert.equal(event.groupId, group.id); assert.equal(event.state, "paused"); assert.equal(event.nextDueAt, null);
      await service.events.tick(); assert.equal(service.native.requests.length, 0);
    } finally { await service.stop(); }
  });
  await withHome(async (home) => {
    await updateAllHands(home, { enabled: true, frequency: "manual" });
    const group = await prepareAllHands(home, [{ slug: "scout" }, { slug: "editor" }]);
    const scout = { slug: "scout", name: "Scout", role: "Reviewer", mission: "Review", createdAt: "2026-09-10T00:00:00.000Z", path: path.join(home, "scout"), workspaceId: "workspace_scout" };
    const service = await eventFixture(home, { members: { scout } });
    try {
      const [event] = await service.events.list();
      assert.equal(event.groupId, group.id); assert.equal(event.state, "active"); assert.equal(event.nextDueAt, null);
      assert.deepEqual(event.participantSlugs, ["scout", "editor"], "migration does not silently drop the missing identity");
      service.members.editor = { ...scout, slug: "editor", name: "Replacement", path: path.join(home, "editor"), workspaceId: "workspace_editor" };
      const run = await service.events.runNow(event.id, "missing-legacy-member");
      await service.events.tick();
      const saved = (await service.events.get(event.id)).runs.find((item) => item.id === run.id);
      assert.equal(saved.status, "failed"); assert.match(saved.error, /original identity was unavailable/);
      assert.equal(service.native.requests.length, 0);
    } finally { await service.stop(); }
  });
});

test("event artifacts use exact native document receipts without sharing private content or another group's outcome", async () => {
  await withHome(async (home) => {
    const documents = {
      1: { id: "brief", title: "Private source title", revision: 1, body: "PRIVATE-ARTIFACT-BODY" },
      2: { id: "brief", title: "Private source title", revision: 2, body: "UPDATED-PRIVATE-ARTIFACT-BODY" },
    };
    let event;
    let other;
    let run;
    let denied = false;
    const service = await eventFixture(home, { readArtifact: async (artifact) => {
      const document = documents[artifact.revision];
      if (!document) throw new Error("Exact revision unavailable"); return document;
    }, onSend: async ({ events, slug, threadId, input, reply }) => {
      if (!input.prompt.includes("Phase: contributions")) return;
      const invoke = async (name, args) => {
        const callID = `${name}_${reply.id}`;
        reply.parts.push({ type: "tool", tool: `coworker_${name}`, toolStatus: "running", callId: callID, toolInput: args });
        try { return await events.executeNative(slug, { name, args, context: { sessionID: threadId, messageID: reply.id, callID, directory: path.join(home, slug) } }); }
        finally { reply.parts.at(-1).toolStatus = "completed"; }
      };
      const calendar = JSON.parse((await invoke("workplace_calendar", {})).text);
      assert.ok(calendar.events.some((item) => item.id === other.id));
      assert.ok(calendar.events.filter((item) => item.state === "paused").every((item) => item.occurrences.length === 0));
      assert.ok(!JSON.stringify(calendar).includes("PRIVATE-CONTEXT"));
      await assert.rejects(invoke("event_details", { id: other.id }), /only to its participants/);
      if (slug === "editor") {
        assert.ok(!input.prompt.includes("Private source title"));
        await assert.rejects(invoke("event_document_read", { id: event.id, runId: run.id, artifact: event.artifacts[0] }), /another coworker identity/);
        denied = true;
      } else {
        for (const tool of ["external_document_update", "external_coworker_document_update"]) {
          reply.parts.push({ type: "tool", tool, callId: tool, toolStatus: "completed", toolInput: { id: "brief" }, toolMetadata: { structuredContent: { document: { ...documents[1], action: "updated" } } } });
        }
        reply.parts.push({ type: "tool", tool: "coworker_document_update", callId: "document_write", toolStatus: "completed", toolInput: { id: "brief" }, toolMetadata: { openworkMcpApp: { isError: false, structuredContent: { document: { ...documents[2], action: "updated" } } } } });
      }
    } });
    try {
      const artifact = { owner: { kind: "coworker", slug: "scout", createdAt: service.members.scout.createdAt }, documentId: "brief", title: "ignored title", revision: 1, relation: "used", contributorSlug: "scout" };
      other = await service.events.create({ ...eventInput(), state: "paused", description: "PRIVATE-CONTEXT" });
      event = await service.events.create({ ...eventInput(), state: "paused", artifacts: [artifact] });
      run = await service.events.runNow(event.id, "artifact-session");
      const [finished] = await service.settle(event.id);
      assert.equal(finished.status, "succeeded", finished.error);
      assert.equal(denied, true);
      assert.deepEqual(finished.artifacts.map((item) => [item.revision, item.relation]), [[1, "used"], [2, "modified"]]);
      assert.ok(service.native.requests.every((request) => !request.prompt.includes("PRIVATE-ARTIFACT-BODY")));
      assert.equal((await service.events.documentRead(event.id, run.id, finished.artifacts[0])).revision, 1);
      const receipts = await service.collaboration.read((state) => state.workplaceEvents.runs[run.id].artifactReceipts);
      assert.ok(receipts.some((receipt) => receipt.callId === "document_write" && receipt.executionId && receipt.messageId));
      assert.ok(receipts.every((receipt) => !receipt.callId.startsWith("external_")), "external document tools cannot claim local artifact provenance");
      await assert.rejects(service.events.documentRead(event.id, run.id, { ...artifact, revision: 3 }), /not recorded/);
    } finally { await service.stop(); }
  });
});

test("event reply and duration budgets are enforced and a missing lead outcome stays partial", async () => {
  await withHome(async (home) => {
    const service = await eventFixture(home, { noConclusion: true, onSend: async ({ collaboration, input }) => {
      if (!input.prompt.includes("Phase: contributions")) return;
      const entry = await collaboration.read((state) => Object.values(state.executions).find((entry) => entry.messageId === input.messageId));
      await assert.rejects(collaboration.request({ entry, callId: "over-budget" }, "worker", { name: "Extra work", goal: "Not within this budget" }), /only the participant round/);
    } });
    try {
      const event = await service.events.create({ ...eventInput(["scout"]), durationMinutes: null });
      const [run] = await service.settle(event.id);
      assert.equal(run.status, "partial"); assert.equal(run.outcome, null);
      assert.equal(service.native.requests.length, 2);
      const stored = await service.collaboration.read((state) => state.workplaceEvents.runs[run.id]);
      assert.equal(stored.deadlineAt - stored.startedAt, 240 * 60_000);
      const expired = await service.events.runNow(event.id, "expiry");
      await service.collaboration.change((state) => { state.workplaceEvents.runs[expired.id].deadlineAt = Date.now() - 1; });
      await service.events.tick();
      const after = (await service.events.get(event.id)).runs.find((run) => run.id === expired.id);
      assert.equal(after.status, "partial"); assert.match(after.error, /duration limit/);
      assert.equal(service.native.requests.length, 2);
    } finally { await service.stop(); }
  });
});

test("event Stop retains exact native failures across restart and cannot release work before confirmed idle", async () => {
  await withHome(async (home) => {
    let mode = "throw";
    let aborts = 0;
    let sends = 0;
    const pin = { providerId: "fixture", modelId: "held", variant: "low" };
    const observations = [];
    const native = nativeFixture(async ({ threadId }) => { native.held.add(threadId); });
    const documents = new Map();
    const finishDocument = (request, id) => {
      const document = { id, title: id, revision: 1, body: "Evidence completed while Stop was waiting for native idle." };
      documents.set(id, document);
      const reply = native.histories.get(request.threadId).find((message) => message.role === "assistant" && message.parentId === request.messageId);
      reply.parts.push({ type: "tool", tool: "coworker_document_create", callId: `write_${id}`, toolStatus: "completed", toolInput: { title: id }, toolMetadata: { structuredContent: { document: { ...document, action: "created" } } } });
      return document;
    };
    const readArtifact = async (artifact) => documents.get(artifact.documentId);
    const clientFor = native.clientFor;
    native.clientFor = async (slug, options = {}) => {
      const client = await clientFor(slug);
      observations.push(options);
      return { ...client, resolvedModel: options.model ?? (options.observationOnly ? undefined : pin),
        getThreadSnapshot: async (...args) => structuredClone(await client.getThreadSnapshot(...args)),
        waitForThread: async (...args) => structuredClone(await client.waitForThread(...args)),
        sendTurn: (...args) => { sends++; return client.sendTurn(...args); },
        abortThread: async (...args) => {
          aborts++;
          if (mode === "throw") throw new Error("fixture native abort transport refused");
          if (mode === "release") return client.abortThread(...args);
          return { accepted: true };
        },
      };
    };
    let service = await eventFixture(home, { native, readArtifact, setupTimeoutMs: 200 });
    try {
      const event = await service.events.create({ ...eventInput(), state: "paused" });
      const first = await service.events.runNow(event.id, "cancel-native");
      await service.events.tick();
      await eventually(() => native.requests.length === 1);
      await eventually(async () => (await service.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.owner.eventRunId === first.id)))?.acceptance);
      await assert.rejects(service.events.cancel(event.id, first.id), /fixture native abort transport refused/);
      const waiting = (await service.events.get(event.id)).runs.find((run) => run.id === first.id);
      assert.equal(waiting.status, "waiting"); assert.equal(waiting.finishedAt, null);
      assert.equal(waiting.stopping, true);
      assert.equal(Object.hasOwn(waiting, "cleanupPending"), false);
      assert.match(waiting.error, /Stop not confirmed.*fixture native abort transport refused/);
      assert.ok(await service.collaboration.read((state) => state.workplaceEvents.runs[first.id].cleanupPending));
      assert.ok(await service.collaboration.read((state) => Object.values(state.executions).some((entry) => entry.cleanupPending && entry.cleanupError.includes("transport refused"))));
      const pendingEntry = await service.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.owner.eventRunId === first.id));
      const observer = await native.clientFor(pendingEntry.owner.slug, { observationOnly: true, model: pin });
      await service.events.captureExecution(pendingEntry, await observer.getThreadSnapshot(pendingEntry.owner.threadId));
      assert.equal(await service.collaboration.read((state) => Object.values(state.executions).some((entry) => entry.owner.eventRunId === first.id && entry.eventArtifactsCaptured)), false, "an earlier busy snapshot must not finish artifact capture");
      const successor = await service.events.runNow(event.id, "after-cancel");
      const { members, services } = service;
      await service.stop();
      service = await eventFixture(home, { native, members, services, readArtifact, setupTimeoutMs: 200 });
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(native.requests.length, 1, "restart must not revive the cancelled speaker or admit the queued successor");
      mode = "ack";
      const reminderStart = Date.now() + 60_000;
      const upcoming = await service.events.create({ ...eventInput(["scout"]), startsAt: reminderStart, schedule: { kind: "once", at: reminderStart, timezone: "Etc/UTC" } });
      await assert.rejects(service.events.tick(), /Native stop .* was not confirmed/);
      assert.ok((await service.collaboration.listActivity()).some((item) => item.kind === "event-reminder" && item.target.eventId === upcoming.id), "pending native cleanup does not block unrelated reminders");
      assert.ok(observations.some((options) => options.observationOnly === true && options.model?.modelId === pin.modelId), "recovered native cleanup observes its saved model without resolving today's default");
      assert.equal(native.requests.length, 1, "an abort acknowledgement does not release admission");
      let settled = false;
      const before = aborts;
      const stopping = service.events.cancel(event.id, first.id).then((result) => { settled = true; return result; });
      await eventually(() => aborts > before);
      assert.equal(settled, false);
      assert.equal((await service.events.get(event.id)).runs.find((run) => run.id === first.id).finishedAt, null);
      const recoveredDocument = finishDocument(native.requests[0], "late-recovered");
      assert.equal(await service.collaboration.read((state) => Object.values(state.executions).some((entry) => entry.owner.eventRunId === first.id && entry.eventArtifactsCaptured)), false, "recovered cleanup cannot finish capture before idle");
      native.held.clear();
      const stopped = await stopping;
      assert.equal(stopped.status, "cancelled"); assert.equal(typeof stopped.finishedAt, "number");
      assert.equal(stopped.stopping, false);
      assert.equal(stopped.outcome, null);
      assert.deepEqual(stopped.artifacts.map(({ documentId, revision, relation }) => ({ documentId, revision, relation })), [{ documentId: recoveredDocument.id, revision: 1, relation: "created" }]);
      assert.deepEqual(await service.events.documentRead(event.id, first.id, stopped.artifacts[0]), recoveredDocument);
      const captured = await service.collaboration.read((state) => ({ entry: Object.values(state.executions).find((entry) => entry.owner.eventRunId === first.id), receipts: state.workplaceEvents.runs[first.id].artifactReceipts }));
      assert.equal(captured.entry.eventArtifactsCaptured, true);
      assert.equal(captured.receipts.length, 1);
      assert.deepEqual([captured.receipts[0].executionId, captured.receipts[0].messageId, captured.receipts[0].callId], [captured.entry.id, native.requests[0].messageId, "write_late-recovered"]);
      assert.deepEqual((await service.events.cancel(event.id, first.id)).artifacts, stopped.artifacts, "repeated cancellation keeps the same artifact receipt");
      assert.equal(await service.collaboration.read((state) => state.workplaceEvents.runs[first.id].cleanupPending), false);
      assert.ok(await service.collaboration.read((state) => Object.values(state.executions).filter((entry) => entry.owner.eventRunId === first.id).every((entry) => !entry.cleanupPending)));
      await service.events.tick();
      await eventually(() => native.requests.length === 2);
      assert.ok(await service.collaboration.read((state) => Object.values(state.executions).some((entry) => entry.owner.eventRunId === successor.id && entry.sentAt)));
      assert.equal(await service.collaboration.read((state) => Object.values(state.executions).filter((entry) => entry.owner.eventRunId === first.id).length), 1);
      const liveBefore = aborts;
      const liveStopping = service.events.cancel(event.id, successor.id);
      await eventually(() => aborts > liveBefore);
      const liveDocument = finishDocument(native.requests[1], "late-live");
      const livePending = (await service.events.get(event.id)).runs.find((run) => run.id === successor.id);
      assert.equal(livePending.status, "waiting"); assert.equal(livePending.finishedAt, null);
      native.held.clear();
      const liveStopped = await liveStopping;
      assert.equal(liveStopped.status, "cancelled"); assert.equal(liveStopped.outcome, null);
      assert.deepEqual(liveStopped.artifacts.map((artifact) => artifact.documentId), [liveDocument.id]);
      assert.deepEqual(await service.events.documentRead(event.id, successor.id, liveStopped.artifacts[0]), liveDocument);
      await service.events.tick();
      assert.equal(native.requests.length, 2, "Stop capture must not replay a turn, resume a cancelled participant or synthesize an outcome");
      assert.equal(sends, 2, "cleanup only reads native history; it never resubmits an admitted message");
      assert.equal(await service.collaboration.read((state) => state.workplaceEvents.runs[successor.id].artifactReceipts.length), 1);
    } finally { mode = "release"; await service.stop(); }
  });
});

test("event budgets reserve every originating handback before delegation while allowing funded parallel Workers", async () => {
  for (const maxReplies of [6, 7]) await withHome(async (home) => {
    const children = [];
    const spawned = [];
    const rejected = [];
    const service = await eventFixture(home, {
      spawn: async (slug, input) => { spawned.push({ slug, id: input.id }); return { id: input.id, status: "running" }; },
      onSend: async ({ collaboration, input, slug }) => {
        if (!input.prompt.includes("Phase: contributions")) return;
        const entry = await collaboration.read((state) => Object.values(state.executions).find((entry) => entry.messageId === input.messageId));
        try {
          const receipt = await collaboration.request({ entry, callId: `worker-${slug}` }, "worker", { name: `${slug} evidence`, goal: "Check the evidence without executing proposals", continuation: { objective: "Review evidence", resumeInstructions: "Report the verified findings" } });
          children.push(receipt.structured.collaboration.id);
        } catch (error) { assert.match(error.message, /reply budget/); rejected.push(slug); }
      },
    });
    try {
      const event = await service.events.create({ ...eventInput(), template: "all-hands", maxReplies });
      await service.events.tick();
      await eventually(async () => !(await service.groups.status(event.groupId)).active && service.native.requests.length === 2 && spawned.length === children.length);
      assert.equal(children.length, maxReplies === 6 ? 1 : 2);
      assert.deepEqual(rejected, maxReplies === 6 ? ["editor"] : []);
      const tasks = await service.collaboration.read((state) => children.map((id) => state.tasks[id]));
      const admissions = await Promise.all(tasks.map((task) => service.collaboration.admitEventWorker({ id: task.workerId, slug: task.origin.slug, pendingTurn: { messageId: `step-${task.id}` } })));
      assert.ok(admissions.every((entry) => entry.promptPrefix.includes("read-only") && entry.promptPrefix.includes("no new permissions")));
      assert.equal(spawned.length, children.length, "rejected delegation must not start a Worker");
      await Promise.all(children.map((id) => service.collaboration.complete(id, { state: "succeeded", result: "Current evidence was checked; proposed work was not executed." })));
      const [run] = await service.settle(event.id);
      assert.equal(run.status, "succeeded", run.error);
      const handbacks = service.native.requests.filter((request) => request.prompt.includes("automatic follow-up"));
      assert.equal(handbacks.length, children.length);
      assert.ok(handbacks.every((request) => request.prompt.includes("All Hands briefing is read-only")));
      assert.equal(Object.keys(await service.collaboration.read((state) => state.workplaceEvents.runs[run.id].usage)).length, 3 + 2 * children.length);
      assert.ok(service.native.requests.at(-1).prompt.includes("Phase: conclusion"));
    } finally { await service.stop(); }
  });
});

test("Event conversation uses ordinary routing and recovery without granting outcome authority or replaying calendar history", async () => {
  await withHome(async (home) => {
    let event;
    let run;
    let failedOnce = false;
    let preview;
    let outcomeRefused = false;
    let snapshotRead;
    const service = await eventFixture(home, {
      coordinator: async () => ({ workspaceId: "workspace_.coordinator" }),
      catalogFor: async () => ({ models: [{ id: "test/model", providerId: "test", modelId: "model", variants: [], source: "local", tier: "key", toolCall: true, status: "active", label: "Test", releaseDate: "" }] }),
      onSend: async ({ events, slug, threadId, input, reply }) => {
        if (slug === ".coordinator") {
          reply.parts.push({ type: "text", text: JSON.stringify({ addressedSlugs: ["scout"], speakers: [{ slug: "scout" }], mode: "sequential" }) });
          return;
        }
        if (!input.prompt.includes("This is ordinary conversation")) return;
        const invoke = async (name, args) => {
          const callID = `${name}_${reply.id}`;
          reply.parts.push({ type: "tool", tool: `coworker_${name}`, toolStatus: "running", callId: callID, toolInput: args });
          try { return await events.executeNative(slug, { name, args, context: { sessionID: threadId, messageID: reply.id, callID, directory: path.join(home, slug) } }); }
          finally { reply.parts.at(-1).toolStatus = "completed"; }
        };
        await assert.rejects(invoke("event_conclude", { outcome: { ...eventOutcome, summary: "This ordinary reply must not replace the outcome." } }), /Only the admitted lead/);
        outcomeRefused = true;
        snapshotRead = JSON.parse((await invoke("event_details", { id: event.id, runId: run.id })).text);
        if (input.prompt.includes("RECOVERY-CHECK") && !failedOnce) { failedOnce = true; throw new Error("fixture ordinary reply failed"); }
        if (input.prompt.includes("CALENDAR-CHECK")) preview = JSON.parse((await invoke("workplace_calendar", { after: Date.now() - 4 * 86400000, before: Date.now() + 5 * 86400000 })).text);
      },
    });
    const idle = async () => eventually(async () => !(await service.groups.status(event.groupId)).active);
    try {
      const input = { ...eventInput(), state: "paused" };
      event = await service.events.create(input);
      await service.events.runNow(event.id, "first-session");
      [run] = await service.settle(event.id);
      await service.events.update(event.id, { ...input, title: "New definition, retained outcome" }, event.revision);
      await service.groups.submit(event.groupId, { clientMessageId: "human-progress", text: "@scout How did the review go?" });
      await idle();
      const turn = (await getGroup(home, event.groupId)).turns.find((turn) => turn.clientMessageId === "human-progress");
      assert.equal(turn.routedBy, "facilitator"); assert.equal(turn.status, "succeeded");
      assert.equal(outcomeRefused, true);
      assert.equal(snapshotRead.event.title, run.event.title);
      assert.deepEqual(snapshotRead.runs[0].outcome, run.outcome);
      assert.deepEqual((await service.events.get(event.id)).runs, [run]);
      const ordinary = await service.collaboration.read((state) => Object.values(state.executions).filter((entry) => entry.groupRequestId === "human-progress"));
      assert.ok(ordinary.every((entry) => !entry.owner.eventRunId && !entry.owner.eventPhase));
      assert.ok(ordinary.every((entry) => entry.owner.conversationIdentity.groupId === event.groupId));
      await service.groups.submit(event.groupId, { clientMessageId: "human-failure", text: "@scout RECOVERY-CHECK" });
      await idle();
      const failed = (await getGroup(home, event.groupId)).turns.find((turn) => turn.clientMessageId === "human-failure");
      assert.equal(failed.status, "failed");
      await service.groups.submit(event.groupId, { clientMessageId: "human-continue", text: failed.prompt, turnId: failed.id });
      await idle();
      assert.equal((await getGroup(home, event.groupId)).turns.find((turn) => turn.id === failed.id).status, "succeeded");
      const scheduled = (await getGroup(home, event.groupId)).turns.find((turn) => turn.clientMessageId.startsWith("event:"));
      await assert.rejects(service.groups.submit(event.groupId, { clientMessageId: "phase-continue", text: scheduled.prompt, turnId: scheduled.id }), /immutable/);
      await assert.rejects(service.groups.remove(event.groupId, scheduled.clientMessageId), /Cancel the Event run/);
      const paused = await service.events.create({ ...eventInput(), state: "paused" });
      const at = Date.now();
      const clock = new Date(at);
      const schedule = { kind: "daily", timezone: "Etc/UTC", hour: clock.getUTCHours(), minute: clock.getUTCMinutes() };
      const future = await service.events.create({ ...eventInput(), startsAt: at + 2 * 86400000, schedule });
      const overdue = await service.events.create({ ...eventInput(), startsAt: at - 3 * 86400000, schedule });
      await service.groups.submit(event.groupId, { clientMessageId: "human-calendar", text: "@scout CALENDAR-CHECK" });
      await idle();
      assert.deepEqual(preview.events.find((item) => item.id === paused.id).occurrences, []);
      assert.deepEqual(preview.events.find((item) => item.id === event.id).occurrences, [], "an exhausted once schedule must not be projected again");
      assert.ok(preview.events.find((item) => item.id === future.id).occurrences.every((slot) => slot >= future.nextDueAt));
      const overdueSlots = preview.events.find((item) => item.id === overdue.id).occurrences;
      assert.ok(overdueSlots.includes(overdue.nextDueAt));
      assert.ok(overdueSlots.every((slot) => slot === overdue.nextDueAt || slot >= at), "only the authoritative overdue slot, never fabricated missed history");
      const before = service.native.requests.length;
      const identity = service.members.scout;
      await service.groups.submit(event.groupId, { clientMessageId: "queued-identity-check", text: "@scout Do not give this to a replacement." });
      service.members.scout = { ...identity, createdAt: "2026-09-12T00:00:00.000Z" };
      await idle();
      assert.equal(service.native.requests.length, before, "identity is rechecked after acceptance and before native routing or reply admission");
      await assert.rejects(service.groups.submit(event.groupId, { clientMessageId: "replacement-check", text: "Hi" }), /original identity/);
      service.members.scout = identity;
      assert.deepEqual((await service.events.get(event.id)).runs, [run]);
    } finally { await service.stop(); }
  });
});

test("Event group Stop cancels both All Hands rhythms and ordinary queued messages while leaving phase controls protected", async () => {
  await withHome(async (home) => {
    await updateAllHands(home, { enabled: true, frequency: "twice" });
    const legacy = await prepareAllHands(home, [{ slug: "scout" }, { slug: "editor" }]);
    await updateAllHands(home, { enabled: false });
    const service = await eventFixture(home, { onSend: async ({ native, threadId, input }) => { if (input.prompt.includes("Phase: contributions")) native.held.add(threadId); } });
    try {
      const events = await service.events.list();
      assert.equal(events.length, 2);
      assert.equal((await service.events.conversationContext(legacy.id)).identity.eventId, (await getGroup(home, legacy.id)).eventId);
      const first = await service.events.runNow(events[0].id, "morning-now");
      const second = await service.events.runNow(events[1].id, "afternoon-now");
      await service.events.tick();
      await eventually(() => service.native.requests.length === 1);
      await service.groups.submit(legacy.id, { clientMessageId: "human-next", text: "@scout How is the briefing?" });
      await service.groups.submit(legacy.id, { clientMessageId: "human-remove", text: "@editor Never send this queued request." });
      await service.groups.remove(legacy.id, "human-remove");
      const phaseId = await service.collaboration.read((state) => state.workplaceEvents.runs[first.id].requests.contributions.id);
      await assert.rejects(service.groups.remove(legacy.id, phaseId), /Cancel the Event run/);
      await service.events.cancelGroup(legacy.id);
      await eventually(async () => !(await service.groups.status(legacy.id)).active);
      assert.equal((await service.events.get(events[0].id)).runs[0].status, "cancelled");
      assert.equal((await service.events.get(events[1].id)).runs[0].status, "cancelled");
      assert.equal((await service.events.get(events[1].id)).runs[0].id, second.id);
      assert.equal(service.native.requests.length, 1, "queued human messages do not start while Stop cancels the Event runs");
      assert.deepEqual(await service.collaboration.read((state) => state.groups[legacy.id].queue), []);
      await assert.rejects(service.groups.submit(legacy.id, { clientMessageId: "human-next", text: "Same stopped request" }), /cancelled/);
      await service.groups.submit(legacy.id, { clientMessageId: "after-group-stop", text: "@editor What was retained?" });
      await eventually(async () => !(await service.groups.status(legacy.id)).active && service.native.requests.length === 2);
      assert.equal((await service.events.get(events[0].id)).runs.length, 1);
      assert.equal((await service.events.get(events[1].id)).runs.length, 1);
    } finally { await service.stop(); }
  });
});

test("Events share Conversation and Facilitator defaults while recovery, recall and observations retain admitted pins", async () => {
  await withHome(async (home) => {
    const provider = fixtureProvider({ id: "fixture", name: "Role models", models: Object.fromEntries(["chat", "chat-next", "personal", "facilitator"].map((id) => [id, { name: id, variants: { high: {}, minimal: {}, low: {}, medium: {} } }])) });
    const catalog = connectedModelCatalog(fixtureCatalog({ all: [provider], connected: [provider.id] }));
    let settings = normalizeSettings({ modelDefaults: { conversation: { model: "fixture/chat", modelVariant: "low" }, facilitator: { model: "fixture/facilitator", modelVariant: "minimal" } } });
    const members = Object.fromEntries(["scout", "editor"].map((slug) => [slug, { slug, name: slug, role: "Reviewer", mission: "Review evidence", model: "fixture/personal", modelVariant: "medium", modelMode: "fixed", useAppModelDefaults: slug === "scout", path: path.join(home, slug), createdAt: "2026-09-10T00:00:00.000Z", workspaceId: `workspace_${slug}` }]));
    const ranked = [];
    const observations = [];
    const published = [];
    let hold = true;
    const options = {
      members, settings: async () => settings,
      coordinator: async () => ({ workspaceId: "workspace_.coordinator" }), catalogFor: async () => catalog,
      memoryContext: async (owner) => owner.kind === "group" ? "GROUP-ONLY-RECALL" : "",
      onPublished: async (entry) => { published.push({ slug: entry.owner.slug, model: entry.model }); },
      resolveModel: (slug, request) => {
        if (request.observationOnly || request.prepareOnly) { if (request.observationOnly) observations.push({ slug, model: request.model }); return request.model ?? undefined; }
        if (request.model) return request.model;
        assert.equal(typeof request.requestText, "string", "preparation and reads must not invoke model ranking");
        const choice = resolveDiscussionModel(catalog, members[slug], request.requestText, settings.modelDefaults);
        assert.ok(choice.model, choice.reason);
        const model = { providerId: choice.model.providerId, modelId: choice.model.modelId, variant: choice.variant };
        ranked.push({ slug, model });
        return model;
      },
      onSend: async ({ slug, threadId, input, reply, native }) => {
        if (slug === ".coordinator") reply.parts.push({ type: "text", text: JSON.stringify({ addressedSlugs: ["editor"], speakers: [{ slug: "editor" }], mode: "sequential" }) });
        else if (hold && slug === "scout" && input.prompt.includes("Phase: contributions")) native.held.add(threadId);
      },
    };
    let service = await eventFixture(home, options);
    try {
      const event = await service.events.create({ ...eventInput(), state: "paused" });
      const accepted = await service.events.runNow(event.id, "model-default-event");
      await service.events.tick();
      await eventually(() => service.native.requests.length === 1);
      const first = await service.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.owner.eventRunId === accepted.id));
      assert.deepEqual(first.model, { providerId: "fixture", modelId: "chat", variant: "low" });
      settings = normalizeSettings({ ...settings, modelDefaults: { ...settings.modelDefaults, conversation: { model: "fixture/chat-next", modelVariant: "high" } } });
      const { native, services } = service;
      await service.stop();
      hold = false;
      service = await eventFixture(home, { ...options, native, services });
      const [completed] = await service.settle(event.id);
      assert.equal(completed.status, "succeeded", completed.error);
      assert.deepEqual(native.requests.map((request) => [request.slug, request.model.modelId, request.model.variant]), [["scout", "chat", "low"], ["editor", "personal", "medium"], ["scout", "chat-next", "high"]]);
      assert.equal(ranked.length, 3, "recovery and artifact/context observations do not re-rank the accepted model");
      assert.ok(observations.some((entry) => entry.model?.modelId === "chat" && entry.model.variant === "low"));
      assert.deepEqual((await service.collaboration.read((state) => state.executions[first.id])).model, first.model);
      assert.ok(native.requests.every((request) => request.context?.includes("GROUP-ONLY-RECALL") && !request.prompt.includes("GROUP-ONLY-RECALL")), "upstream synthetic recall stays separate from Event/user prompts");
      assert.deepEqual(published.map((entry) => entry.slug), ["scout", "editor", "scout"], "the upstream group publication memory hook survives the Event merge");
      await service.groups.submit(event.groupId, { clientMessageId: "human-role-followup", text: "@editor How did the review go?" });
      await eventually(async () => !(await service.groups.status(event.groupId)).active && native.requests.length === 5);
      assert.deepEqual(native.requests[3].model, { providerId: "fixture", modelId: "facilitator", variant: "minimal" });
      assert.deepEqual(native.requests[4].model, { providerId: "fixture", modelId: "personal", variant: "medium" });
      assert.equal((await service.events.get(event.id)).runs.length, 1, "the human follow-up is not a new scheduled phase");
    } finally { hold = false; await service.stop(); }
  });
});

test("Event management uses direct human authority and durable operation receipts across replay and restart", async () => {
  await withHome(async (home) => {
    let outsider, created, updated, sourceForResume, pauseReceipt;
    const at = Date.now() + 3600000;
    const input = { ...eventInput(), title: "  Native planning  ", startsAt: at, schedule: { kind: "once", at, timezone: "Etc/UTC" }, state: "paused" };
    let service = await eventFixture(home, { onSend: async (source) => {
      if (source.input.prompt === "DIRECT EVENT WRITES") {
        created = await eventCall(source, "event_create", { input }, "create-original");
        assert.deepEqual(await eventCall(source, "event_create", { input }, "create-repeat"), created);
        const patch = { ...input, title: "Native planning", description: "A changed working prompt" };
        const args = { id: created.event.id, input: patch, expectedRevision: created.event.revision };
        updated = await eventCall(source, "event_update", args, "update-original");
        await source.events.update(created.event.id, { ...patch, title: "Edited by the person" }, updated.event.revision);
        assert.deepEqual(await eventCall(source, "event_update", args, "update-repeat"), updated, "the accepted receipt survives a later revision");
        await assert.rejects(eventCall(source, "event_create", { input: { ...input, title: "Changed call arguments" } }, "create-original"), /different accepted arguments/);
        await assert.rejects(eventCall(source, "event_update", { id: outsider.id, input: { ...eventInput(), state: "paused", startsAt: at, schedule: input.schedule }, expectedRevision: outsider.revision }, "join-other"), /original identity|participants/);
        for (let index = 0; index < 3; index++) await eventCall(source, "event_create", { input: { ...input, title: `Additional requested event ${index}` } }, `extra-${index}`);
        await assert.rejects(eventCall(source, "event_create", { input: { ...input, title: "Beyond request limit" } }, "over-limit"), /5-operation/);
        sourceForResume = source;
        source.native.held.add(source.threadId);
      } else if (source.input.prompt.includes("The person's message: @scout HUMAN-PAUSE")) {
        const editor = source.members.editor;
        delete source.members.editor;
        try {
          const current = (await source.events.get(created.event.id)).event;
          pauseReceipt = await eventCall(source, "event_manage", { id: current.id, action: "pause", expectedRevision: current.revision });
        } finally { source.members.editor = editor; }
        const manualArgs = { id: created.event.id, action: "run_now" };
        const manual = await eventCall(source, "event_manage", manualArgs, "run-manual");
        assert.deepEqual(await eventCall(source, "event_manage", manualArgs, "run-manual-repeat"), manual);
        const cancelled = await eventCall(source, "event_manage", { id: created.event.id, action: "cancel_run", runId: manual.run.id }, "cancel-manual");
        assert.equal(cancelled.run.status, "cancelled");
        assert.equal(cancelled.run.leadSlug, "scout");
      }
    } });
    try {
      outsider = await service.events.create({ ...eventInput(["editor"]), state: "paused", startsAt: at, schedule: input.schedule });
      const owner = { slug: "scout", threadId: "ses_event_management", conversationId: "ses_event_management", kind: "private" };
      const root = await service.collaboration.submit({ owner, prompt: "DIRECT EVENT WRITES", messageId: "msg_event_management", track: true });
      await eventually(() => sourceForResume && service.native.held.has(owner.threadId));
      assert.equal((await service.events.list()).length, 5);
      const receipts = await service.collaboration.read((state) => Object.values(state.workplaceEvents.writeReceipts));
      assert.equal(receipts.length, 5);
      const acceptedContext = await service.collaboration.read((state) => state.executions[root.id].executionContext);
      assert.ok(acceptedContext.length <= EVENT_CONTEXT_LIMIT);
      const { native, members, services } = service;
      await service.stop();
      sourceForResume.reply.completedAt = null;
      const firstPart = sourceForResume.reply.parts.find((part) => part.callId === "create-original");
      firstPart.toolInput = { input }; firstPart.toolStatus = "running";
      native.held.add(owner.threadId);
      service = await eventFixture(home, { native, members, services });
      const source = { ...service, slug: "scout", threadId: owner.threadId, reply: sourceForResume.reply };
      await eventually(async () => {
        try { await service.collaboration.context("scout", { sessionID: owner.threadId, messageID: source.reply.id, callID: "create-original", directory: members.scout.path }, { name: "coworker_event_create", args: { input } }, assertEventToolContext); return true; }
        catch { return false; }
      });
      assert.deepEqual(await eventCall(source, "event_create", { input }, "create-original"), created);
      assert.equal((await service.events.list()).length, 5);
      assert.equal((await service.events.get(created.event.id)).event.revision, 3);
      assert.equal(await service.collaboration.read((state) => state.executions[root.id].executionContext), acceptedContext, "observation recovery does not replace accepted Event context");
      source.reply.completedAt = Date.now(); native.held.clear();
      await eventually(async () => (await service.collaboration.read((state) => state.executions[root.id])).state === "succeeded");
      const current = (await service.events.get(created.event.id)).event;
      await service.events.update(current.id, { ...eventInputSchema.parse(current), state: "active" }, current.revision);
      await service.groups.submit(current.groupId, { clientMessageId: "human-pause", text: "@scout HUMAN-PAUSE" });
      await eventually(async () => !(await service.groups.status(current.groupId)).active);
      assert.equal(pauseReceipt?.event.state, "paused", "a verified human group turn can disable despite a missing peer");
      const groupEntry = await service.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.groupRequestId === "human-pause"));
      assert.equal(groupEntry.personRequest, true); assert.equal(groupEntry.tools.coworker_computer_act, false);
      for (const patch of [{ personRequest: false }, { continuation: true }, { continuedFrom: "earlier" }, { attempts: 1 }, { owner: { ...owner, kind: "worker" } }, { owner: { ...owner, kind: "consultation" } }, { owner: { ...owner, eventRunId: "scheduled" } }]) {
        assert.throws(() => assertEventHumanOrigin({ ...groupEntry, ...patch }), /direct human request/);
      }
      const awareness = await service.events.context({ ...owner, coworkerIdentity: coworkerIdentity(members.scout) });
      assert.ok(awareness.length <= EVENT_CONTEXT_LIMIT); assert.ok(!awareness.includes(outsider.id));
    } finally { service.native.held.clear(); await service.stop(); }
  });
});

test("Event continuity freezes at start and stop retains published contributions without inventing a delivered outcome", async () => {
  await withHome(async (home) => {
    let stopId, partialId;
    const document = { id: "retained", title: "Retained work", revision: 1, body: "A real retained result." };
    const service = await eventFixture(home, { readArtifact: async () => document, onSend: async (source) => {
      const entry = await source.collaboration.read((state) => Object.values(state.executions).find((entry) => entry.messageId === source.input.messageId));
      if (!entry?.owner.eventRunId) return;
      assert.equal(source.input.tools, undefined);
      assert.equal(source.input.agent, nativeTurnAgent({ tools: entry.tools }));
      assert.equal(entry.tools.coworker_event_create, false); assert.equal(entry.tools.coworker_assignment_create, false);
      if (entry.owner.eventRunId === stopId && source.slug === "scout") source.reply.parts.push({ type: "tool", tool: "coworker_document_create", callId: "created-before-stop", toolStatus: "completed", toolInput: { title: document.title }, toolMetadata: { openworkMcpApp: { structuredContent: { document: { ...document, action: "created" } } } } });
      if (entry.owner.eventRunId === stopId && source.slug === "editor") source.native.held.add(source.threadId);
      if (entry.owner.eventRunId === partialId && source.slug === "editor") throw new Error("A contribution could not finish.");
      if (entry.owner.eventRunId === partialId && entry.owner.eventPhase === "conclusion") source.native.held.add(source.threadId);
    } });
    try {
      const event = await service.events.create({ ...eventInput(), state: "paused", description: "The working prompt stays intact." });
      await service.events.runNow(event.id, "delivered-first");
      const [first] = await service.settle(event.id);
      assert.equal(first.outcomeStatus, "delivered");
      const stopping = await service.events.runNow(event.id, "stopped-second"); stopId = stopping.id;
      const queued = await service.events.runNow(event.id, "partial-third"); partialId = queued.id;
      assert.equal(queued.continuity, undefined, "queued occurrences do not prematurely freeze continuity");
      await service.events.tick();
      await eventually(async () => service.native.held.size > 0 && (await service.events.get(event.id)).runs.find((run) => run.id === stopId).contributorSlugs.includes("scout"));
      const stopped = await service.events.cancel(event.id, stopId);
      assert.deepEqual(stopped.contributorSlugs, ["scout"]); assert.equal(stopped.artifacts[0].relation, "created");
      assert.equal(stopped.outcome, null); assert.equal(stopped.outcomeStatus, null);
      await eventually(async () => {
        await service.events.tick();
        return (await service.events.get(event.id)).runs.find((run) => run.id === partialId).outcomeStatus === "provisional";
      });
      const live = (await service.events.get(event.id)).runs.find((run) => run.id === partialId);
      assert.equal(live.continuity.sourceRunId, first.id); assert.equal(live.continuity.previousRunId, stopped.id);
      assert.deepEqual(live.continuity.openQuestions, first.outcome.openQuestions);
      assert.deepEqual(live.continuity.followUps, first.outcome.followUps);
      const request = await service.collaboration.read((state) => state.groups[event.groupId].queue[0]);
      const prompt = await service.events.requestContext(request, event.leadSlug);
      const prefix = `Scheduled workplace event ${event.title}.\nObjective: ${event.objective}\nWorking prompt: ${event.description}\n\n`;
      assert.ok(prompt.startsWith(prefix)); assert.ok(prompt.slice(prefix.length).length <= EVENT_DYNAMIC_LIMIT);
      service.native.held.clear();
      const finished = (await service.settle(event.id)).find((run) => run.id === partialId);
      assert.equal(finished.status, "partial"); assert.equal(finished.outcomeStatus, "delivered");
      assert.equal((await service.events.get(event.id)).continuity.sourceRunId, partialId);
      assert.equal(finished.continuity.sourceRunId, first.id, "the started occurrence retains its original continuity");
      const fullOutcome = { ...finished.outcome, summary: "S".repeat(1001), openQuestions: Array.from({ length: 6 }, (_, index) => `${index}: ${"Q".repeat(181)}`), followUps: Array.from({ length: 5 }, (_, index) => `${index}: ${"F".repeat(181)}`) };
      await service.collaboration.change((state) => { state.workplaceEvents.runs[partialId].outcome = fullOutcome; });
      const preview = await service.events.get(event.id);
      assert.deepEqual({ summaryLength: preview.continuity.summary.length, questions: preview.continuity.openQuestions.length, followUps: preview.continuity.followUps.length,
        itemLength: preview.continuity.openQuestions[0].length, note: preview.continuity.note.length <= 240 && /6 questions, 5 follow-ups total/.test(preview.continuity.note)
          && preview.continuity.note.includes("Read sourceRunId via event_details before concluding; omitted items are not resolved."),
        source: preview.runs.find((run) => run.id === partialId).outcome },
      { summaryLength: 1000, questions: 4, followUps: 4, itemLength: 180, note: true, source: fullOutcome }, "truncated continuity directs a full source read without changing the complete source outcome");
      service.members.ops = { ...service.members.editor, slug: "ops", name: "Ops", path: path.join(home, "ops"), workspaceId: "workspace_ops" };
      const current = (await service.events.get(event.id)).event;
      await service.events.update(event.id, { ...eventInputSchema.parse(current), participantSlugs: ["scout", "editor", "ops"], maxReplies: 4 }, current.revision);
      const changed = await service.events.get(event.id);
      assert.equal(changed.continuity.sourceRunId, null); assert.equal(changed.continuity.summary, "");
      assert.match(changed.continuity.note, /snapshot differs/);
    } finally { service.native.held.clear(); await service.stop(); }
  });
});

test("Event recurrence ends inclusively and state-only disabling survives unavailable participants and pruned artifacts", async () => {
  await withHome(async (home) => {
    let clock = Date.UTC(2026, 8, 11, 10), available = true;
    const service = await eventFixture(home, { startGroups: false, now: () => clock, readArtifact: async () => {
      if (!available) throw new Error("Revision was pruned");
      return { id: "brief", title: "Brief", revision: 1, body: "Existing artifact" };
    } });
    try {
      const end = Date.UTC(2026, 8, 10, 9);
      const event = await service.events.create({ ...eventInput(), startsAt: Date.UTC(2026, 8, 8, 9), schedule: { kind: "daily", hour: 9, minute: 0, timezone: "Etc/UTC" }, repeatUntil: end });
      await service.events.tick();
      const detail = await service.events.get(event.id);
      assert.equal(detail.runs.length, 1); assert.equal(detail.runs[0].scheduledFor, end); assert.equal(detail.event.nextDueAt, null);
      await service.events.cancel(event.id, detail.runs[0].id);
      clock += 8 * 86400000; await service.events.tick();
      assert.equal((await service.events.get(event.id)).runs.length, 1, "an ended repetition does not manufacture more occurrences");
      const future = clock + 86400000;
      const withArtifact = await service.events.create({ ...eventInput(), startsAt: future, schedule: { kind: "once", at: future, timezone: "Etc/UTC" }, artifacts: [{ owner: { kind: "coworker", slug: "scout", createdAt: service.members.scout.createdAt }, documentId: "brief", title: "Brief", revision: 1, relation: "used", contributorSlug: "scout" }] });
      delete service.members.editor; available = false;
      const paused = await service.events.update(withArtifact.id, { ...eventInputSchema.parse(withArtifact), state: "paused" }, withArtifact.revision);
      assert.equal(paused.state, "paused"); assert.equal(paused.nextDueAt, null);
      const archived = await service.events.update(paused.id, { ...eventInputSchema.parse(paused), state: "archived" }, paused.revision);
      assert.equal(archived.state, "archived");
      const expired = await service.events.create({ ...eventInput(["scout"]), state: "paused", startsAt: clock - 1, schedule: { kind: "once", at: clock - 1, timezone: "Etc/UTC" } });
      await assert.rejects(service.events.update(expired.id, { ...eventInputSchema.parse(expired), state: "active" }, expired.revision), /one-time event has no future occurrence/);
      const repeating = await service.events.create({ ...eventInput(["scout"]), state: "paused", startsAt: clock - 86400000, schedule: { kind: "weekly", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0, timezone: "Etc/UTC" }, repeatUntil: clock + 8 * 86400000 });
      const resumed = await service.events.update(repeating.id, { ...eventInputSchema.parse(repeating), state: "active", title: "Renamed weekday review" }, repeating.revision);
      assert.ok(resumed.nextDueAt > clock && resumed.nextDueAt <= resumed.repeatUntil);
      assert.equal((await getGroup(home, resumed.groupId)).name, resumed.title);
      assert.equal(service.native.requests.length, 0);
      assert.deepEqual(eventToolCatalog().map((tool) => tool.name).slice(-3), ["coworker_event_create", "coworker_event_update", "coworker_event_manage"]);
    } finally { await service.stop(); }
  });
});

test("queued Event writes reject ended tool parts and abandoned HTTP transports without accepting a run", async () => {
  for (const mode of ["tool-ended", "transport"]) await withHome(async (home) => {
    const prepared = Promise.withResolvers(), finish = Promise.withResolvers();
    const abandoned = new AbortController();
    let preparing = false, validations = 0, source, requestPromise, backendPromise, serverSignal, server;
    let target;
    const service = await eventFixture(home, {
      readArtifact: async () => { preparing = true; await prepared.promise; return { id: "gate", title: "Gate", revision: 1, body: "Fixture only" }; },
      onContextResolved: (_slug, expected) => { if (expected.name === "coworker_event_manage") validations++; },
      onSend: async (current) => {
        if (current.input.prompt !== "EVENT QUEUE CANCELLATION") return;
        const args = { id: target.id, action: "run_now" };
        const part = { type: "tool", tool: "coworker_event_manage", toolStatus: "running", callId: "queued-run", toolInput: args };
        current.reply.parts.push(part);
        const input = { name: "event_manage", args, context: { sessionID: current.threadId, messageID: current.reply.id, callID: part.callId, directory: current.members.scout.path }, signal: { aborted: false } };
        source = { ...current, part };
        if (mode === "transport") {
          requestPromise = fetch(server.url.replace(/\/mcp$/, "/context"), { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-event-transport" }, body: JSON.stringify(input), signal: abandoned.signal });
          await assert.rejects(requestPromise);
        } else {
          requestPromise = current.events.executeNative("scout", input);
          await assert.rejects(requestPromise, /exact active native execution/);
        }
        await finish.promise;
      },
    });
    let blocker;
    try {
      target = await service.events.create({ ...eventInput(), state: "paused" });
      blocker = service.events.create({ ...eventInput(["scout"]), state: "paused", title: "Hold Event serial preparation", artifacts: [{ owner: { kind: "coworker", slug: "scout", createdAt: service.members.scout.createdAt }, documentId: "gate", title: "Gate", revision: 1, relation: "used", contributorSlug: "scout" }] });
      await eventually(() => preparing);
      if (mode === "transport") server = await createCoworkerToolsServer({ resolveSlug: (token) => token === "fixture-event-transport" ? "scout" : null, handlers: {}, onContextTool: (slug, input, signal) => {
        serverSignal = signal;
        assert.notEqual(input.signal, signal, "payloads cannot supply transport authority");
        backendPromise = service.events.executeNative(slug, input, signal);
        void backendPromise.catch(() => {});
        return backendPromise;
      } });
      const root = await service.collaboration.submit({ owner: { slug: "scout", threadId: "ses_queued_event_tool", conversationId: "ses_queued_event_tool", kind: "private" }, messageId: "msg_queued_event_tool", prompt: "EVENT QUEUE CANCELLATION", track: true });
      await eventually(() => Boolean(validations === 1 && source && requestPromise));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal((await service.collaboration.read((state) => state.executions[root.id])).state, "running");
      if (mode === "tool-ended") source.part.toolStatus = "error";
      else {
        assert.equal(serverSignal.aborted, false, "normal request-body end must not cancel the callback");
        abandoned.abort();
        await eventually(() => serverSignal.aborted);
        assert.equal(source.part.toolStatus, "running", "transport cancellation is independent of parent/tool status");
      }
      prepared.resolve(); await blocker;
      await assert.rejects(mode === "transport" ? backendPromise : requestPromise, mode === "transport" ? /transport disconnected/ : /exact active native execution/);
      assert.deepEqual((await service.events.get(target.id)).runs, []);
      assert.equal((await service.collaboration.read((state) => state.executions[root.id])).state, "running", "the parent may remain active but the ended call cannot commit");
    } finally {
      prepared.resolve(); finish.resolve(); abandoned.abort();
      await blocker?.catch(() => {});
      await backendPromise?.catch(() => {});
      await service.stop(); await server?.stop();
    }
  });
});

test("a shared human group request deduplicates run_now across authorized participants and restart", async () => {
  await withHome(async (home) => {
    let event, service, hold = true, rejectSecond = true, deniedReplay = false;
    const receipts = [];
    const options = { onContextResolved: async (slug, expected) => {
      if (slug === "editor" && expected.name === "coworker_event_manage" && rejectSecond) {
        rejectSecond = false;
        await service.collaboration.change((state) => { state.workplaceEvents.definitions[event.id].participantSlugs = ["scout"]; });
      }
    }, onSend: async (source) => {
      if (!source.input.prompt.includes("The person's message: @everyone RUN ONE SHARED OCCURRENCE")) return;
      const args = { id: event.id, action: "run_now" };
      if (source.slug === "editor") {
        try {
          await assert.rejects(eventCall(source, "event_manage", args, "unauthorized-replay"), /roster changed|participant/);
          deniedReplay = true;
          assert.equal(await source.collaboration.read((state) => Object.values(state.workplaceEvents.writeCalls).length), 1);
        } finally { await source.collaboration.change((state) => { state.workplaceEvents.definitions[event.id].participantSlugs = ["scout", "editor"]; }); }
      }
      const receipt = await eventCall(source, "event_manage", args, `run-${source.slug}`);
      receipts.push({ slug: source.slug, receipt });
      if (source.slug === "scout" && hold) source.native.held.add(source.threadId);
    } };
    service = await eventFixture(home, options);
    try {
      event = await service.events.create({ ...eventInput(), state: "paused" });
      await service.groups.submit(event.groupId, { clientMessageId: "shared-human-request", text: "@everyone RUN ONE SHARED OCCURRENCE" });
      await eventually(() => receipts.length === 1 && service.native.held.size === 1);
      const { native, members, services } = service;
      await service.stop(); hold = false;
      service = await eventFixture(home, { ...options, native, members, services });
      await eventually(async () => receipts.length === 2 && !(await service.groups.status(event.groupId)).active);
      assert.deepEqual(receipts.map((entry) => entry.slug), ["scout", "editor"]);
      assert.equal(deniedReplay, true, "a cached semantic receipt never substitutes for the second caller's authorization");
      assert.equal(receipts[0].receipt.run.id, receipts[1].receipt.run.id);
      const detail = await service.events.get(event.id);
      assert.equal(detail.runs.length, 1); assert.equal(detail.runs[0].status, "queued");
      const stored = await service.collaboration.read((state) => ({ receipts: Object.values(state.workplaceEvents.writeReceipts), calls: Object.values(state.workplaceEvents.writeCalls) }));
      assert.equal(stored.receipts.length, 1); assert.equal(stored.calls.length, 2);
      assert.equal(new Set(stored.calls.map((call) => call.key)).size, 1);
      assert.equal(native.requests.length, 2, "recovery observes the accepted first speaker rather than running it twice");
    } finally { hold = false; service.native.held.clear(); await service.stop(); }
  });
});

test("Event update plugin and catalog require full replacement fields while create retains defaults", () => {
  const tools = new Map();
  const plugin = new Function("Plugin", "Effect", "schema", EVENT_PLUGIN
    .replace(/^import .*;\n/gm, "").replace("export default", "return"))({ define: (definition) => definition }, { gen: (run) => run() }, z);
  const registration = plugin.effect({ tool: { transform: (apply) => { apply({ add: (tool) => tools.set(tool.name, tool) }); return []; } } });
  assert.equal(registration.next().done, true);
  const validate = (name, args) => tools.get(name).input["~standard"].validate(args);
  const full = eventInput();
  const names = ["description", "template", "durationMinutes", "maxReplies", "state", "artifacts"];
  const catalog = eventToolCatalog();
  const updateCatalog = catalog.find((entry) => entry.name === "coworker_event_update").inputSchema;
  const fromCatalog = z.fromJSONSchema(updateCatalog);
  for (const name of names) {
    const input = { ...full }; delete input[name];
    const args = { id: "event", input, expectedRevision: 1 };
    assert.equal(eventNativeSchemas.event_update.safeParse(args).success, false, name);
    assert.equal(fromCatalog.safeParse(args).success, false, name);
    assert.ok(validate("coworker_event_update", args).issues, name);
    assert.equal(eventNativeSchemas.event_create.safeParse({ input }).success, true, "create may supply defaults");
    assert.equal(validate("coworker_event_create", { input }).issues, undefined);
  }
  assert.equal(updateCatalog.properties.input.required.includes("repeatUntil"), false);
  const args = { id: "event", input: { ...full, title: "  Preserve raw native arguments  " }, expectedRevision: 1 };
  assert.equal(eventNativeSchemas.event_update.safeParse(args).success, true);
  assert.equal(fromCatalog.safeParse(args).success, true);
  assert.deepEqual(validate("coworker_event_update", args).value, args, "native schema validation preserves raw arguments for exact-call verification");
  assert.ok(JSON.stringify(catalog).length <= 10000);
});
