import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertGroupActionToolContext, createGroupActions } from "./group-actions.mjs";
import { createGroup, EVENT_GROUP_AUTHORITY, getGroup } from "./groups.mjs";
import { createGroupExecution } from "./group-execution.mjs";

async function withHome(run) {
  const home = await mkdtemp(path.join(tmpdir(), "coworker-group-actions-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

test("group participant preparation starts on demand before a native thread is admitted", async () => {
  await withHome(async (home) => {
    const group = await createGroup(home, { name: "Planning", participantSlugs: ["scout", "editor"] });
    const requests = [];
    const execution = createGroupExecution({ directory: home, coworkerFor: async (slug) => ({ slug, workspaceId: `ws_${slug}`, createdAt: "identity" }),
      clientFor: async (_slug, options) => { requests.push(options); return { coworkerCreatedAt: "identity", createThread: async () => ({ id: "ses_new" }) }; },
      collaboration: { registerOwner: async (owner) => owner }, setupTimeoutMs: 100 });
    try {
      assert.equal((await execution.participant(group.id, "scout")).threadId, "ses_new");
      assert.equal((await execution.participant(group.id, "scout")).threadId, "ses_new");
      assert.deepEqual(requests.map(({ threadId, observationOnly, prepareOnly, sessionKind }) => ({ threadId, observationOnly, prepareOnly, sessionKind })), [
        { threadId: undefined, observationOnly: undefined, prepareOnly: true, sessionKind: "group" },
        { threadId: "ses_new", observationOnly: undefined, prepareOnly: true, sessionKind: "group" },
      ]);
    } finally { await execution.stop(); }
  });
});

test("a triggered group coworker registers a missing workspace without selecting a model early", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const declaration = source.match(/^async function collaborationClient\([\s\S]*?^\}/m)?.[0];
  assert.ok(declaration);
  let coworker = { slug: "scout", name: "Scout", path: "/tmp/scout", createdAt: "identity", workspaceId: "" };
  let registrations = 0;
  let warmups = 0;
  const clientFor = runInNewContext(`${declaration}\ncollaborationClient`, {
    maintenanceAdmission: { assertOpen: () => {} }, getCoworker: async () => coworker,
    ensurePlatformServer: async () => ({ config: { workspaces: [] }, url: "http://localhost" }),
    registerCoworkerWorkspace: async () => { registrations += 1; return "ws_team"; },
    updateCoworker: async (_dir, _slug, patch) => (coworker = { ...coworker, ...patch }),
    sessionBinding: async () => null, teamWorkspace: () => ({ workspaceId: "ws_team" }),
    ensureToolsServer: async () => ({}), installNativeCoworkerPlugins: async () => {},
    toolsRegistered: new Set(["scout"]), warmCoworkerWorkspace: async () => { warmups += 1; },
    localRunModel: async () => assert.fail("preparation must not choose the turn's model"),
    ownedSessionClient: () => ({}), createCoworkerThreads: () => ({ listThreadInteractions: () => [], replyPermission: () => {}, replyQuestion: () => {}, rejectQuestion: () => {} }),
    coworkerAgent: () => "coworker-scout", coworkerIdentity: () => ({}), ownerToken: "fixture", coworkersDir: "/tmp", path,
  });
  const client = await clientFor("scout", { sessionKind: "group", prepareOnly: true });
  assert.equal(client.workspaceId, "ws_team");
  assert.equal(client.resolvedModel, undefined);
  assert.equal(registrations, 1);
  assert.equal(warmups, 1);
});

test("native group actions keep direct group authority and exact call arguments", () => {
  const args = { action: "add", participantSlugs: ["ops"] };
  const context = { sessionID: "ses_group", messageID: "assistant", callID: "call", directory: "/tmp/scout" };
  const entry = { state: "running", sentAt: 1, personRequest: true, messageId: "human", workspaceId: "ws_scout", owner: { kind: "group", groupId: "grp_12345678", conversationId: "grp_12345678", slug: "scout", threadId: "ses_group" } };
  const snapshot = { threadId: "ses_group", directory: "/tmp/scout", messages: [
    { id: "human", role: "user", parts: [{ type: "text", text: "Add Ops" }] },
    { id: "assistant", role: "assistant", parentId: "human", parts: [{ type: "tool", tool: "coworker_group_manage", callId: "call", toolStatus: "running", toolInput: args }] },
  ] };
  const invoke = (patch = {}) => assertGroupActionToolContext({ slug: "scout", context, name: "coworker_group_manage", args, entry, snapshot, workspaceId: "ws_scout", active: true, ...patch });
  assert.doesNotThrow(() => invoke());
  assert.throws(() => invoke({ entry: { ...entry, personRequest: false } }), /direct human request/);
  assert.throws(() => invoke({ args: { ...args, participantSlugs: ["editor"] } }), /exact direct request/);
  assert.throws(() => invoke({ context: { ...context, sessionID: "ses_other" } }), /exact direct request/);
});

test("group actions add and remove members and create one separate chat from an Event conversation", async () => {
  await withHome(async (home) => {
    const ordinary = await createGroup(home, { name: "Planning", participantSlugs: ["scout", "editor"] });
    const eventGroup = await createGroup(home, { name: "Event", participantSlugs: ["scout", "editor"], eventId: "event_1" }, { authority: EVENT_GROUP_AUTHORITY });
    let groupId = ordinary.id;
    let executionId = "execution";
    let call = 0;
    const actions = createGroupActions({ coworkersDir: home, coworkers: async () => ["scout", "editor", "ops"].map((slug) => ({ slug })),
      resolveContext: async () => ({ entry: { id: executionId, groupRequestId: "human-request", owner: { groupId } }, assertActive: () => {} }) });
    const invoke = (args) => actions.executeNative("scout", { args, context: { callID: `call_${++call}` } });
    assert.deepEqual((await invoke({ action: "add", participantSlugs: ["ops"] })).participantSlugs, ["scout", "editor", "ops"]);
    assert.deepEqual((await invoke({ action: "remove", participantSlugs: ["editor"] })).participantSlugs, ["scout", "ops"]);
    await assert.rejects(invoke({ action: "remove", participantSlugs: ["scout"] }), /at least two/);
    assert.deepEqual((await getGroup(home, ordinary.id)).participantSlugs, ["scout", "ops"]);
    groupId = eventGroup.id;
    await assert.rejects(invoke({ action: "add", participantSlugs: ["ops"] }), /Event participants/);
    const args = { action: "start_parallel", participantSlugs: ["scout", "ops"], title: "Follow-up planning" };
    const context = { callID: "parallel" };
    const first = await actions.executeNative("scout", { args, context });
    const repeated = await actions.executeNative("scout", { args, context });
    assert.deepEqual(repeated, first);
    executionId = "other-speaker";
    assert.deepEqual(await actions.executeNative("scout", { args: { ...args, participantSlugs: ["ops", "scout"] }, context: { callID: "other-call" } }), first);
    assert.equal((await getGroup(home, first.id)).eventId, undefined);
    assert.deepEqual(first.participantSlugs, ["ops", "scout"]);
  });
});
