import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createCoworker, getCoworker, restoreCoworker, retireCoworker, updateCoworker, withCoworkerRecordWrite } from "./coworkers.mjs";
import { appendGroupEvent, archiveGroup, createGroup, getGroup, updateGroup } from "./groups.mjs";
import { createMessageReactions, normalizeReactionEmoji } from "./message-reactions.mjs";
import { assertReactionToolContext, createMessageReactionRuntime, hasCompletedReaction, reactionOpportunity, REACTION_TOOL } from "./message-reactions-context.mjs";
import { assertTeamConsultToolContext } from "./collaboration.mjs";
import { NATIVE_TURN_ROLES } from "./native-turns.mjs";
import { projectNativeV2History } from "@openwork/headless-threads/v2";

const authorize = async () => {};
const hash = (value) => createHash("sha256").update(value).digest("hex");
const publicActor = ({ slug, name, createdAt }) => ({ slug, name, createdAt });
const privateScope = (actor, threadId = "thread-one") => ({ kind: "private", slug: actor.slug, threadId });
const command = (scope, actor, operationId, emoji = "👀", messageId = "message-one", admission = {
  threadId: scope.kind === "private" ? scope.threadId : `${scope.groupId}-${actor.slug}`,
  messageId: "admitted-message-one",
}) => ({ scope, actor, operationId, emoji, messageId, admission });
const storePath = (directory, scope) => scope.kind === "private"
  ? path.join(directory, scope.slug, `.message-reactions-${hash(scope.threadId)}.json`)
  : path.join(directory, ".groups", scope.groupId, ".message-reactions.json");

test("reaction opportunities stay near one third and follow personality", () => {
  const samples = Array.from({ length: 2000 }, (_, index) => `coworker:turn-${index}`);
  const count = (personality) => samples.filter((seed) => reactionOpportunity(personality, seed)).length;
  assert.ok(count("neutral") > 500 && count("neutral") < 700);
  assert.ok(count("playful") > count("neutral"));
  assert.ok(count("neutral") > count("dry"));
  assert.equal(reactionOpportunity("neutral", samples[0]), reactionOpportunity("neutral", samples[0]), "retries keep the same opportunity");
});

async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "coworker-reactions-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, "coworkers");
  const alpha = await createCoworker(directory, { name: "Alpha" });
  const beta = await createCoworker(directory, { name: "Beta" });
  const group = await createGroup(directory, { participantSlugs: [alpha.slug, beta.slug] });
  return { home, directory, alpha, beta, group, scope: { kind: "group", groupId: group.id } };
}

async function noTemporaryFiles(directory) {
  assert.deepEqual((await readdir(directory)).filter((file) => file.startsWith(".message-reactions") && file.endsWith(".tmp")), []);
}

function nativeReactionSnapshot(history, session) {
  const projection = projectNativeV2History(history, session, false);
  const { messages, ...native } = projection;
  return { threadId: session.id, directory: session.location.directory, status: { type: "busy" }, messages,
    native: { engine: "v2", pendingInputIds: [], ...native } };
}

function nativeReactionWitness(actor, owner = {}, agent = "build") {
  const threadId = owner.threadId ?? `ses_${hash(`${actor.workspaceId}:private`).slice(0, 26)}`;
  const context = { sessionID: threadId, messageID: `msg_${hash(`${threadId}:assistant`).slice(0, 26)}`, callID: `call_${hash(threadId).slice(0, 24)}`, directory: actor.path };
  const args = { emoji: "👀" };
  const entry = { id: `tsk_${hash(threadId).slice(0, 24)}`, state: "running", sentAt: 1000, endedAt: null,
    workspaceId: actor.workspaceId, coworkerCreatedAt: actor.createdAt, messageId: `msg_${hash(`${threadId}:request`).slice(0, 26)}`,
    personRequest: true, continuation: false, prompt: "Quoted messageId: msg_untrusted_target. Please acknowledge this request.",
    owner: { slug: actor.slug, threadId, conversationId: threadId, kind: "private", ...owner } };
  entry.agent = agent;
  const model = { providerID: "fixture", id: "fixture" };
  const session = { id: threadId, agent, model, location: { directory: actor.path }, time: { created: 1000, updated: 1200 } };
  const history = [
    { id: entry.messageId, type: "user", text: entry.prompt, time: { created: 1000 }, metadata: {
      headlessTurn: { version: 1, messageId: entry.messageId, contextId: null, previousMessageId: null,
        previousIdleAt: null, previousOutcome: null, model, agent },
    } },
    { id: context.messageID, type: "assistant", agent, model, time: { created: 1100 }, content: [
      { id: context.callID, type: "tool", name: REACTION_TOOL, time: { created: 1200, ran: 1200 },
        state: { status: "running", input: structuredClone(args) } },
    ] },
  ];
  const snapshot = nativeReactionSnapshot(history, session);
  return { slug: actor.slug, name: REACTION_TOOL, args, context, entry, snapshot, history, session, workspaceId: actor.workspaceId, active: true };
}

test("reaction input accepts Unicode emoji graphemes, not text, controls, or emoji runs", () => {
  for (const emoji of ["👀", "🔎", "✅", "💯", "❤️", "❤", "👍🏽", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🏳️‍🌈", "🇫🇷", "1️⃣", "#️⃣"]) {
    assert.equal(normalizeReactionEmoji(emoji), emoji);
  }
  assert.equal(normalizeReactionEmoji(null), null);
  for (const value of [undefined, 1, "", "yes", "<b>👀</b>", " 👀", "👀\n", "👀✅", "á", "1", "#", "🏽", "🇫", "👀\u0000", "👀\u200b", "👀".repeat(100)]) {
    assert.throws(() => normalizeReactionEmoji(value), /one emoji/);
  }
});

test("reactions survive reopening, isolate scopes, retain peers, and never replay an older command", async (t) => {
  const { directory, alpha, beta, scope } = await fixture(t);
  const events = [];
  let clock = 1000;
  const options = { directory, now: () => clock++, onChange: async (changedScope, revision) => { events.push({ scope: changedScope, revision }); throw new Error("Subscriber failed"); } };
  const first = createMessageReactions(options);
  const second = createMessageReactions(options);
  const original = command(scope, alpha, "first-operation");
  await Promise.all([first.set(original, { authorize }), second.set(command(scope, beta, "peer-operation", "💯"), { authorize })]);
  assert.equal((await first.read(scope)).revision, 2);
  assert.equal((await first.read(scope)).reactions.length, 2);
  const replacement = command(scope, alpha, "replacement-operation", "✅");
  assert.equal((await first.set(replacement, { authorize })).revision, 3);
  const unchanged = await first.set(command(scope, alpha, "same-emoji-operation", "✅"), { authorize });
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.revision, 3);
  const reopened = createMessageReactions(options);
  assert.deepEqual(await reopened.set(original, { authorize }), { revision: 3, messageId: "message-one", emoji: "✅", actor: publicActor(alpha), changed: false, duplicate: true });
  await assert.rejects(reopened.set({ ...original, emoji: "🔎" }, { authorize }), /different reaction arguments/);
  await assert.rejects(reopened.set({ ...original, messageId: "different-message" }, { authorize }), /different reaction arguments/);
  await assert.rejects(reopened.set({ ...original, admission: { ...original.admission, messageId: "different-admission" } }, { authorize }), /different reaction arguments/);
  await assert.rejects(reopened.set({ ...original, admission: { ...original.admission, threadId: "different-native-thread" } }, { authorize }), /different reaction arguments/);
  assert.equal((await reopened.set(command(scope, alpha, "remove-operation", null), { authorize })).revision, 4);
  assert.deepEqual(await reopened.set(replacement, { authorize }), { revision: 4, messageId: "message-one", emoji: null, actor: publicActor(alpha), changed: false, duplicate: true });
  assert.equal((await reopened.set(command(scope, alpha, "remove-again-operation", null), { authorize })).changed, false);
  const groupState = await createMessageReactions({ directory }).read(scope);
  assert.deepEqual(groupState.reactions.map(({ emoji, actor }) => ({ emoji, actor })), [{ emoji: "💯", actor: publicActor(beta) }]);
  const privateOne = privateScope(alpha);
  await reopened.set(command(privateOne, alpha, "first-operation", "❤️"), { authorize });
  assert.deepEqual(await reopened.read(privateScope(alpha, "thread-two")), { revision: 0, reactions: [] });
  assert.deepEqual(await reopened.read(privateScope(beta)), { revision: 0, reactions: [] });
  const otherGroup = await createGroup(directory, { participantSlugs: [alpha.slug, beta.slug] });
  assert.deepEqual(await reopened.read({ kind: "group", groupId: otherGroup.id }), { revision: 0, reactions: [] });
  assert.deepEqual(events.filter((event) => event.scope.kind === "group").map((event) => event.revision).sort(), [1, 2, 3, 4]);
  const target = storePath(directory, scope);
  assert.equal((await stat(target)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(target, "utf8"), /first-operation|workspaceId|"path"|"text"/);
  await noTemporaryFiles(path.dirname(target));
});

test("native reaction authorization binds verified v2 projection IDs to the exact running tool and caller", () => {
  const base = nativeReactionWitness({ slug: "alpha", path: "/native/alpha", workspaceId: "workspace-alpha", createdAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(base.snapshot.threadId, base.context.sessionID);
  assert.equal(base.snapshot.messages[1].id, base.context.messageID);
  assert.equal(base.snapshot.messages[1].parentId, base.entry.messageId);
  assert.equal(base.snapshot.messages[1].parts[0].callId, base.context.callID);
  assert.doesNotThrow(() => assertReactionToolContext(base));
  for (const [label, mutate] of [
    ["actor", (value) => { value.slug = "beta"; }],
    ["conversation", (value) => { value.entry.owner.conversationId = "another-conversation"; }],
    ["session", (value) => { value.context.sessionID = "ses_other"; }],
    ["snapshot session", (value) => { value.snapshot.threadId = "ses_other"; }],
    ["workspace", (value) => { value.workspaceId = "workspace-beta"; }],
    ["directory", (value) => { value.context.directory = "/native/beta"; }],
    ["message", (value) => { value.context.messageID = "msg_other"; }],
    ["parent", (value) => { value.snapshot.messages[1].parentId = "msg_other"; }],
    ["call", (value) => { value.context.callID = "call_other"; }],
    ["name", (value) => { value.name = "coworker_worker_spawn"; }],
    ["native tool name", (value) => { value.snapshot.messages[1].parts[0].tool = "coworker_worker_spawn"; }],
    ["input", (value) => { value.args.emoji = "✅"; }],
    ["ended message", (value) => { value.snapshot.messages[1].completedAt = 2000; }],
    ["ended tool", (value) => { value.snapshot.messages[1].parts[0].toolStatus = "completed"; }],
    ["inactive", (value) => { value.active = false; }],
    ["unverified projection", (value) => { delete value.snapshot.native; }],
    ["ambiguous projection", (value) => { value.snapshot.native.ambiguousTurns.push(value.entry.messageId); }],
    ["app deny", (value) => { value.entry.tools = { coworker_react: false }; }],
    ["cancelled", (value) => { value.entry.state = "cancelled"; }],
    ["Worker", (value) => { value.entry.owner.kind = "worker"; }],
    ["coordinator", (value) => { value.entry.owner.kind = "coordinator"; }],
  ]) {
    const value = structuredClone(base);
    mutate(value);
    assert.throws(() => assertReactionToolContext(value), /exact running tool call/, label);
  }
  assert.equal(Object.hasOwn(base.history[1], "parentID"), false);
  assert.equal(Object.hasOwn(base.history[1].content[0], "callID"), false);
  for (const mutate of [
    (value) => { delete value.history[0].metadata; },
    (value) => { value.history[1].agent = "another-agent"; },
    (value) => { value.history[1].model = { providerID: "fixture", id: "another-model" }; },
    (value) => { value.session.revert = { messageID: value.entry.messageId }; },
    (value) => { value.history.splice(1, 0, { id: "msg_foreign", type: "synthetic", text: "Not admitted", time: { created: 1050 } }); },
  ]) {
    const value = structuredClone(base);
    mutate(value);
    value.snapshot = nativeReactionSnapshot(value.history, value.session);
    assert.equal(value.snapshot.messages.at(-1).parentId, null);
    assert.throws(() => assertReactionToolContext(value), /exact running tool call/);
    assert.equal(hasCompletedReaction(value.snapshot, value.entry.messageId), false);
  }
  const eventRoles = NATIVE_TURN_ROLES.filter((role) => role.id.startsWith("coworker-group") && /read-only|conclusion/.test(role.id));
  assert.ok(eventRoles.length > 0);
  for (const role of eventRoles) {
    const value = nativeReactionWitness({ slug: "alpha", path: "/native/alpha", workspaceId: "workspace-alpha", createdAt: "2026-01-01T00:00:00.000Z" },
      { kind: "group", groupId: "grp_12345678", conversationId: "grp_12345678", eventRunId: "event-run", eventPhase: role.id.endsWith("-conclusion") ? "conclusion" : "contribution" }, role.id);
    value.entry.tools = role.tools;
    assert.doesNotThrow(() => assertReactionToolContext(value), role.id);
  }
  const override = structuredClone(base);
  override.args = { ...override.args, actor: { slug: "beta" }, scope: { kind: "private", slug: "beta", threadId: "ses_other" } };
  override.snapshot.messages[1].parts[0].toolInput = structuredClone(override.args);
  assert.throws(() => assertReactionToolContext(override), /Choose one emoji/);
  // A valid reaction call must not be reusable at a sibling /context handler.
  const consult = { ...structuredClone(base), name: "coworker_team_consult", args: { to: "beta", question: "Check this" } };
  assert.throws(() => assertTeamConsultToolContext(consult), /exact running native tool call/);
  Object.assign(consult.snapshot.messages[1].parts[0], { tool: consult.name, toolInput: structuredClone(consult.args) });
  assert.doesNotThrow(() => assertTeamConsultToolContext(consult));

  const ordered = structuredClone(base);
  ordered.entry.reactionTargets = { defaultMessageId: ordered.entry.messageId, messageIds: [ordered.entry.messageId] };
  ordered.snapshot.messages[1].parts.push({ ...structuredClone(ordered.snapshot.messages[1].parts[0]), id: "prt_newer", callId: "call_newer", toolInput: { emoji: null } });
  assert.throws(() => assertReactionToolContext(ordered), /superseded/);
  ordered.snapshot.messages[1].parts[1].toolStatus = "error";
  assert.throws(() => assertReactionToolContext(ordered), /superseded/, "a lost newer response cannot resurrect an older reaction");
  ordered.snapshot.messages[1].parts[1].toolStatus = "running";
  ordered.context.callID = "call_newer";
  ordered.args = { emoji: null };
  assert.doesNotThrow(() => assertReactionToolContext(ordered));
  const later = structuredClone(ordered.snapshot.messages[1]);
  later.id = "msg_earlier_lexically";
  later.parts = [{ ...later.parts[1], callId: "call_latest", toolStatus: "error" }];
  ordered.snapshot.messages.push(later);
  assert.throws(() => assertReactionToolContext(ordered), /superseded/);
  later.parentId = "another-admission";
  assert.doesNotThrow(() => assertReactionToolContext(ordered));
  assert.equal(hasCompletedReaction(base.snapshot, base.entry.messageId), false);
  const completed = structuredClone(base);
  completed.snapshot.messages[1].parts[0].toolStatus = "completed";
  assert.equal(hasCompletedReaction(completed.snapshot, completed.entry.messageId), true);
  assert.equal(hasCompletedReaction(completed.snapshot, "another-admission"), false);
  completed.snapshot.messages[1].parts[0].toolStatus = "error";
  assert.equal(hasCompletedReaction(completed.snapshot, completed.entry.messageId), false);
});

test("native reaction runtime freezes visible targets and revalidates at the rename boundary", async (t) => {
  const { directory, alpha: initial, beta, group, scope } = await fixture(t);
  const alpha = await updateCoworker(directory, initial.slug, { workspaceId: "workspace-alpha" });
  let current = nativeReactionWitness(alpha);
  const privateEntry = current.entry;
  const executions = { [privateEntry.id]: privateEntry };
  const nativeController = new AbortController();
  let beforeValidation = async () => {};
  let rawArgs;
  const collaboration = {
    read: async (select) => select(structuredClone({ executions })),
    context: async (slug, context, expected, validate) => {
      assert.equal(expected.name, REACTION_TOOL);
      assert.equal(expected.args, rawArgs);
      await beforeValidation();
      const entry = structuredClone(current.entry);
      const assertActive = () => {
        nativeController.signal.throwIfAborted();
        if (!current.active || current.entry.id !== entry.id || current.entry.state !== "running") throw new Error("Native execution stopped.");
      };
      assertActive();
      validate({ ...current, slug, context, ...expected, entry, snapshot: structuredClone(current.snapshot) });
      return { entry, signal: nativeController.signal, assertActive };
    },
  };
  const runtime = createMessageReactionRuntime({ directory, collaboration, reactionAllowed: () => true,
    coworkerFor: (slug) => getCoworker(directory, slug),
    assertPrivate: async (slug, threadId) => {
      if (slug !== alpha.slug || threadId !== privateEntry.owner.threadId) throw new Error("Not this saved private discussion.");
      return getCoworker(directory, slug);
    },
  });
  const quietRuntime = createMessageReactionRuntime({ directory, collaboration, reactionAllowed: () => false,
    coworkerFor: (slug) => getCoworker(directory, slug),
    assertPrivate: async () => alpha,
  });
  let sequence = 0;
  const invoke = (args, { before = async () => {}, signal } = {}) => {
    beforeValidation = before;
    rawArgs = args;
    current.context = { ...current.context, callID: `call_reaction_${++sequence}` };
    current.snapshot.messages[1].completedAt = null;
    Object.assign(current.snapshot.messages[1].parts[0], { callId: current.context.callID, toolStatus: "running", toolInput: structuredClone(args) });
    return runtime.execute(alpha.slug, args, { ...current.context }, signal);
  };
  const prepare = async () => {
    const prepared = await runtime.prepare(current.entry, current.snapshot);
    assert.ok(prepared);
    current.entry.reactionTargets = { messageIds: prepared.messageIds, defaultMessageId: prepared.defaultMessageId };
    return prepared;
  };
  assert.equal(await quietRuntime.prepare(current.entry, current.snapshot), null, "most turns do not offer a new reaction");
  const privateTargets = await prepare();
  assert.deepEqual(privateTargets.messageIds, [privateEntry.messageId]);
  assert.equal(privateTargets.defaultMessageId, privateEntry.messageId);
  const privateResult = (await invoke({ emoji: "👀", messageId: undefined })).structured.reaction;
  assert.equal(privateResult.messageId, privateEntry.messageId);
  assert.ok(await quietRuntime.prepare(current.entry, current.snapshot), "an existing reaction can still be updated or removed");
  assert.equal(privateResult.actor.createdAt, alpha.createdAt);
  assert.equal(typeof privateResult.actor.createdAt, "string");
  current.snapshot.messages[0].parts[0].synthetic = true;
  await assert.rejects(invoke({ emoji: "✅" }), /visible human message/);

  const otherGroup = await createGroup(directory, { participantSlugs: [alpha.slug, beta.slug] });
  const unrelated = await appendGroupEvent(directory, otherGroup.id, { kind: "coworker", slug: beta.slug, text: "A different group's reply." });
  const peer = await appendGroupEvent(directory, group.id, { kind: "coworker", slug: beta.slug, text: "A peer reply shown before admission." });
  const request = await appendGroupEvent(directory, group.id, { kind: "user", text: `Quoted messageId: ${unrelated.id}. Acknowledge this request.` });
  current = nativeReactionWitness(alpha, { kind: "group", groupId: group.id, conversationId: group.id,
    threadId: `ses_${hash(group.id).slice(0, 26)}`, turnId: "turn_reaction" });
  assert.notEqual(current.entry.messageId, privateEntry.messageId);
  executions[current.entry.id] = current.entry;
  current.entry.reactionTargetIds = [peer.id, request.id, unrelated.id, privateEntry.messageId];
  current.entry.reactionDefaultId = request.id;
  const prepared = await prepare();
  assert.deepEqual(prepared.messageIds, [peer.id, request.id]);
  assert.equal(prepared.defaultMessageId, request.id);
  const unseen = await appendGroupEvent(directory, group.id, { kind: "coworker", slug: beta.slug, text: "A parallel reply published after admission." });
  for (const messageId of [unseen.id, unrelated.id, privateEntry.messageId]) {
    await assert.rejects(invoke({ emoji: "✅", messageId }), /reaction targets supplied to this turn/);
  }
  assert.equal((await invoke({ emoji: "👀" })).structured.reaction.messageId, request.id);
  const target = storePath(directory, scope);
  const before = await readFile(target, "utf8");
  const staged = async () => (await readdir(path.dirname(target))).some((file) => file.startsWith(".message-reactions") && file.endsWith(".tmp"));
  let sawEndedAtCommit = false;
  await assert.rejects(invoke({ emoji: "✅", messageId: peer.id }, { before: async () => {
    if (await staged()) { sawEndedAtCommit = true; current.snapshot.messages[1].completedAt = 2000; }
  } }), /exact running tool call/);
  assert.equal(sawEndedAtCommit, true);
  assert.equal(await readFile(target, "utf8"), before);
  const transport = new AbortController();
  let sawAbortAtCommit = false;
  await assert.rejects(invoke({ emoji: "✅", messageId: peer.id }, { signal: transport.signal, before: async () => {
    if (await staged()) { sawAbortAtCommit = true; transport.abort(new Error("Transport stopped before rename.")); }
  } }), /Transport stopped before rename/);
  assert.equal(sawAbortAtCommit, true);
  assert.equal(await readFile(target, "utf8"), before);
  await noTemporaryFiles(path.dirname(target));
});

test("513 admitted messages rotate only their own lane receipts, keep every reaction, and reject obsolete admissions", async (t) => {
  const { directory, alpha, beta, scope } = await fixture(t);
  let service = createMessageReactions({ directory });
  const running = new Map();
  const laneKey = (input) => JSON.stringify([input.actor.slug, input.actor.createdAt, input.admission.threadId]);
  const authorizeFor = (input) => async () => {
    const current = running.get(laneKey(input));
    if (!current || current.admission.messageId !== input.admission.messageId || current.operationId !== input.operationId) {
      throw new Error("The native tool admission is no longer current.");
    }
  };
  const admit = async (input) => {
    running.set(laneKey(input), input);
    return service.set(input, { authorize: authorizeFor(input) });
  };
  const peer = command(scope, beta, "peer-tool", "💯", "peer-message");
  const parallel = command(scope, alpha, "parallel-tool", "🔎", "parallel-message", { threadId: "parallel-native-thread", messageId: "parallel-admission" });
  await Promise.all([admit(peer), admit(parallel)]);
  const target = storePath(directory, scope);
  const otherLanes = JSON.parse(await readFile(target, "utf8")).receipts;
  let oldest;
  for (let index = 0; index < 513; index++) {
    const input = command(scope, alpha, `native-tool-${index}`, "👀", `visible-message-${index}`, {
      threadId: "sequential-native-thread", messageId: `admitted-message-${index}`,
    });
    if (index === 0) oldest = input;
    if (index === 256) service = createMessageReactions({ directory });
    assert.equal((await admit(input)).changed, true);
  }
  service = createMessageReactions({ directory });
  const snapshot = await service.read(scope);
  assert.equal(snapshot.reactions.length, 515);
  assert.deepEqual(snapshot.reactions.filter((reaction) => reaction.messageId.startsWith("visible-message-")).map((reaction) => reaction.messageId),
    Array.from({ length: 513 }, (_, index) => `visible-message-${index}`));
  const before = await readFile(target, "utf8");
  const stored = JSON.parse(before);
  assert.equal(stored.receipts.length, 3);
  assert.deepEqual(stored.receipts.slice(0, 2), otherLanes);
  assert.deepEqual(stored.receipts[2].admission, { threadId: "sequential-native-thread", messageId: "admitted-message-512" });
  await assert.rejects(service.set(oldest, { authorize: authorizeFor(oldest) }), /no longer current/);
  assert.equal((await service.set(peer, { authorize: authorizeFor(peer) })).duplicate, true);
  assert.equal((await service.set(parallel, { authorize: authorizeFor(parallel) })).duplicate, true);
  assert.equal(await readFile(target, "utf8"), before);
  await noTemporaryFiles(path.dirname(target));
});

test("retirement shares the record lock, and recreated slugs neither inherit nor replace old identities", async (t) => {
  const { directory, alpha, scope } = await fixture(t);
  const service = createMessageReactions({ directory });
  const privateOne = privateScope(alpha);
  await service.set(command(scope, alpha, "historical-group"), { authorize });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const saving = service.set(command(privateOne, alpha, "before-retirement"), { authorize: async () => { entered.resolve(); await release.promise; } });
  await entered.promise;
  const retiring = retireCoworker(directory, alpha.slug, { now: 1_700_000_000_000 });
  release.resolve();
  assert.equal((await saving).changed, true);
  const retired = await retiring;
  const filename = path.basename(storePath(directory, privateOne));
  assert.equal(JSON.parse(await readFile(path.join(retired.path, filename), "utf8")).reactions[0].emoji, "👀");
  await assert.rejects(service.set(command(privateOne, alpha, "after-retirement", "✅"), { authorize }));
  await assert.rejects(stat(alpha.path), { code: "ENOENT" });
  const replacement = await createCoworker(directory, { name: alpha.name });
  assert.notEqual(replacement.createdAt, alpha.createdAt);
  assert.deepEqual(await service.read(privateOne), { revision: 0, reactions: [] });
  await assert.rejects(service.set(command(scope, alpha, "stale-actor", "✅"), { authorize }), /replaced/);
  const newActor = command(scope, replacement, "new-actor", "✅");
  newActor.admission.messageId = "replacement-admission";
  await service.set(newActor, { authorize });
  await service.set({ ...newActor, operationId: "remove-new-actor", emoji: null }, { authorize });
  assert.deepEqual((await service.read(scope)).reactions.map(({ actor, emoji }) => ({ actor, emoji })), [{ actor: publicActor(alpha), emoji: "👀" }]);
  assert.ok(JSON.parse(await readFile(storePath(directory, scope), "utf8")).receipts.some((receipt) => receipt.id === hash("historical-group")));
  await retireCoworker(directory, replacement.slug, { now: 1_700_000_010_000 });
  const restored = await restoreCoworker(directory, retired.archiveId);
  assert.equal(restored.createdAt, alpha.createdAt);
  assert.equal((await service.read(privateOne)).reactions[0].emoji, "👀");
  await Promise.all([
    updateCoworker(directory, alpha.slug, { workspaceId: "workspace-new" }),
    assert.rejects(service.set(command(privateOne, alpha, "stale-workspace"), { authorize }), /workspace changed/),
  ]);
  const current = await getCoworker(directory, alpha.slug);
  assert.equal((await service.set(command(privateOne, current, "current-workspace", "🔎"), { authorize })).changed, true);
});

test("group reactions share metadata serialization, require active membership, and leave archived history readable", async (t) => {
  const { directory, alpha, beta, group, scope } = await fixture(t);
  const service = createMessageReactions({ directory });
  const home = path.join(directory, ".groups", group.id);
  const metadata = await readFile(path.join(home, "group.json"), "utf8");
  const timeline = await readFile(path.join(home, "timeline.jsonl"), "utf8");
  await service.set(command(scope, alpha, "metadata-unchanged"), { authorize });
  assert.equal(await readFile(path.join(home, "group.json"), "utf8"), metadata);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const saving = service.set(command(scope, alpha, "before-membership-change", "✅"), { authorize: async () => { entered.resolve(); await release.promise; } });
  await entered.promise;
  const removing = updateGroup(directory, group.id, { participantSlugs: [beta.slug, "third-member"] });
  release.resolve();
  await saving;
  await removing;
  await assert.rejects(service.set(command(scope, alpha, "removed-member", "🔎"), { authorize }), /active group membership/);
  await archiveGroup(directory, group.id);
  assert.notEqual((await getGroup(directory, group.id)).archivedAt, null);
  await assert.rejects(service.set(command(scope, beta, "archived-group"), { authorize }), /active group membership/);
  assert.equal((await createMessageReactions({ directory }).read(scope)).reactions[0].emoji, "✅");
  assert.equal(await readFile(path.join(home, "timeline.jsonl"), "utf8"), timeline);
});

test("authorization is inside the write lock and failed or cancelled authorization leaves no saved change or temporary file", async (t) => {
  const { directory, alpha } = await fixture(t);
  const scope = privateScope(alpha);
  const events = [];
  const service = createMessageReactions({ directory, onChange: (...event) => events.push(event) });
  await assert.rejects(service.set(command(scope, alpha, "missing-authorizer")), /trusted authorizer/);
  const missingAdmission = command(scope, alpha, "missing-admission");
  delete missingAdmission.admission;
  await assert.rejects(service.set(missingAdmission, { authorize }), /reaction command/);
  for (const admission of [undefined, null, { threadId: "native" }, { threadId: "native", messageId: "" }, { threadId: "native", messageId: "admitted", epoch: 1 }]) {
    await assert.rejects(service.set({ ...command(scope, alpha, "invalid-admission"), admission }, { authorize }), /exact host native admission/);
  }
  await assert.rejects(service.set(command(scope, alpha, "denied-empty-store"), { authorize: async () => { throw new Error("Target not visible"); } }), /not visible/);
  await assert.rejects(stat(storePath(directory, scope)), { code: "ENOENT" });
  await service.set(command(scope, alpha, "initial"), { authorize });
  const before = await readFile(storePath(directory, scope), "utf8");
  await assert.rejects(service.set(command(scope, alpha, "denied", "✅"), { authorize: async () => false }), /not authorized/);
  let checks = 0;
  const controller = new AbortController();
  const nextAdmission = command(scope, alpha, "cancel-at-commit", "✅", "message-one", { threadId: scope.threadId, messageId: "next-admitted-message" });
  await assert.rejects(service.set(nextAdmission, { authorize: async () => {
    checks++;
    if (checks === 2) controller.abort();
    controller.signal.throwIfAborted();
  } }), { name: "AbortError" });
  assert.equal(checks, 2);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const blocker = withCoworkerRecordWrite(directory, alpha.slug, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  let checked = false;
  const cancelled = service.set(command(scope, alpha, "cancel-in-queue", "✅"), { authorize: async () => { checked = true; controller.signal.throwIfAborted(); } });
  assert.equal(checked, false);
  const rejected = assert.rejects(cancelled, { name: "AbortError" });
  release.resolve();
  await Promise.all([blocker, rejected]);
  assert.equal(checked, true);
  assert.equal(await readFile(storePath(directory, scope), "utf8"), before);
  assert.equal(events.length, 1);
  await noTemporaryFiles(alpha.path);
});

test("storage rejects outside actors, linked stores and homes, and replacement of a pinned home", async (t) => {
  const { home, directory, alpha, scope } = await fixture(t);
  const service = createMessageReactions({ directory });
  const outside = path.join(home, "outside");
  await mkdir(outside);
  const sentinel = path.join(outside, "protected.json");
  await writeFile(sentinel, "untouched");
  const privateOne = privateScope(alpha);
  await assert.rejects(service.set(command(privateOne, { ...alpha, path: outside }, "outside-actor"), { authorize }), /coworker directory/);
  await assert.rejects(service.read({ kind: "private", slug: "../outside", threadId: "thread-one" }), /scope/);
  await assert.rejects(service.read({ kind: "group", groupId: "../outside" }), /scope/);
  await service.set(command(privateOne, alpha, "initial"), { authorize });
  await service.set(command(privateScope(alpha, "../../protected.json"), alpha, "safe-hashed-thread", "👀", "../../protected.json"), { authorize });
  const original = await readFile(storePath(directory, privateOne), "utf8");
  const target = storePath(directory, scope);
  await symlink(sentinel, target);
  await assert.rejects(service.read(scope), /links/);
  await assert.rejects(service.set(command(scope, alpha, "linked-sidecar"), { authorize }), /links/);
  await unlink(target);
  for (const linkedHome of [alpha.path, path.join(directory, ".groups", scope.groupId), path.join(directory, ".groups")]) {
    const saved = path.join(home, "displaced");
    await rename(linkedHome, saved);
    await symlink(outside, linkedHome, "dir");
    await assert.rejects(service.read(linkedHome === alpha.path ? privateOne : scope), /symbolic links/);
    await assert.rejects(service.set(command(linkedHome === alpha.path ? privateOne : scope, alpha, "linked-home"), { authorize }), /symbolic links/);
    await unlink(linkedHome);
    await rename(saved, linkedHome);
  }
  const displaced = path.join(home, "original-home");
  await assert.rejects(service.set(command(privateOne, alpha, "replaced-home", "✅"), { authorize: async () => {
    await rename(alpha.path, displaced);
    await mkdir(alpha.path);
    await copyFile(path.join(displaced, "coworker.md"), path.join(alpha.path, "coworker.md"));
  } }), /replaced or retired/);
  assert.deepEqual(await readdir(alpha.path), ["coworker.md"]);
  assert.equal(await readFile(path.join(displaced, path.basename(storePath(directory, privateOne))), "utf8"), original);
  assert.equal(await readFile(sentinel, "utf8"), "untouched");
  assert.deepEqual(await readdir(outside), ["protected.json"]);
  await noTemporaryFiles(displaced);
});

test("corrupt, unreadable, oversized, or full stores fail closed without evicting reactions or replay protection", async (t) => {
  const { directory, alpha, scope } = await fixture(t);
  const service = createMessageReactions({ directory });
  const first = command(scope, alpha, "old-operation");
  await service.set(first, { authorize });
  await service.set(command(scope, alpha, "new-operation", "✅"), { authorize });
  const target = storePath(directory, scope);
  const original = await readFile(target, "utf8");
  const mixedAdmissions = JSON.parse(original);
  mixedAdmissions.receipts[1].admission.messageId = "different-admission-in-one-lane";
  for (const invalid of ["{broken", JSON.stringify({ ...JSON.parse(original), revision: -1 }), JSON.stringify(mixedAdmissions), " ".repeat(2 * 1024 * 1024 + 1)]) {
    await writeFile(target, invalid);
    await assert.rejects(service.read(scope));
    await assert.rejects(service.set(command(scope, alpha, "invalid-store", null), { authorize }));
    assert.equal(await readFile(target, "utf8"), invalid);
  }
  await writeFile(target, original);
  await chmod(target, 0o000);
  try {
    await assert.rejects(service.read(scope));
    await assert.rejects(service.set(command(scope, alpha, "unreadable-store", null), { authorize }));
  } finally { await chmod(target, 0o600); }
  assert.equal(await readFile(target, "utf8"), original);
  const legacy = JSON.parse(original);
  legacy.version = 1;
  legacy.receipts = legacy.receipts.map(({ id, fingerprint }) => ({ id, fingerprint }));
  const legacyBytes = JSON.stringify(legacy);
  await writeFile(target, legacyBytes);
  assert.deepEqual((await service.read(scope)).reactions, legacy.reactions);
  await assert.rejects(service.set(command(scope, alpha, "legacy-write"), { authorize }), /read-only/);
  assert.equal(await readFile(target, "utf8"), legacyBytes);
  const receiptsFull = JSON.parse(original);
  while (receiptsFull.receipts.length < 512) {
    const index = receiptsFull.receipts.length;
    const laneIndex = Math.floor(index / 32);
    const admission = laneIndex === 0 ? first.admission : { threadId: `held-native-thread-${laneIndex}`, messageId: "held-admission" };
    receiptsFull.receipts.push({ id: hash(`filler-${index}`), fingerprint: hash("fixture"),
      lane: hash(JSON.stringify([alpha.slug, alpha.createdAt, admission.threadId])), admission });
  }
  await writeFile(target, JSON.stringify(receiptsFull));
  const receiptBytes = await readFile(target, "utf8");
  await assert.rejects(service.set(command(scope, alpha, "admission-overflow", "🔎"), { authorize }), /this native admission/);
  const overflow = command(scope, alpha, "lane-overflow", "🔎", "message-one", { threadId: "seventeenth-native-thread", messageId: "seventeenth-admission" });
  await assert.rejects(service.set(overflow, { authorize }), /across native lanes/);
  assert.equal((await service.set(first, { authorize })).emoji, "✅");
  assert.equal(await readFile(target, "utf8"), receiptBytes);
  const nextAdmission = { ...first, operationId: "new-admission-at-capacity", admission: { ...first.admission, messageId: "next-admission" } };
  await service.set(nextAdmission, { authorize });
  const rotated = JSON.parse(await readFile(target, "utf8"));
  const firstLane = receiptsFull.receipts[0].lane;
  assert.equal(rotated.receipts.length, 481);
  assert.deepEqual(rotated.receipts.filter((receipt) => receipt.lane !== firstLane), receiptsFull.receipts.filter((receipt) => receipt.lane !== firstLane));
  const reactionsFull = JSON.parse(original);
  reactionsFull.revision = 2000;
  reactionsFull.reactions = Array.from({ length: 2000 }, (_, index) => ({ ...reactionsFull.reactions[0], messageId: `message-${index}` }));
  await writeFile(target, JSON.stringify(reactionsFull));
  const reactionBytes = await readFile(target, "utf8");
  await assert.rejects(service.set(command(scope, alpha, "slot-overflow", "🔎", "new-slot"), { authorize }), /reaction limit/);
  assert.equal(await readFile(target, "utf8"), reactionBytes);
  await service.set(command(scope, alpha, "replace-at-capacity", "🔎", "message-0"), { authorize });
  assert.equal((await service.read(scope)).reactions.length, 2000);
  await noTemporaryFiles(path.dirname(target));
});
