import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe } from "@openwork/testkit";
import {
  object, records, string, SHARED_INSTALL_ID, WORKSPACE_ID,
  remoteSessionRegistration, remoteSessionAutomationPresence,
} from "../worlds/remote-session-registration.ts";

const test = spec.world(remoteSessionRegistration, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm", "node"] },
  resources: { surfaces: [], services: ["den"] },
});
const presenceTest = spec.world(remoteSessionAutomationPresence, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm", "node"] },
  resources: { surfaces: [], services: ["den"] },
});

test("a member's registered runner survives retries without sharing commands with another organization or member", async ({ world, probe, step, evidence }) => {
  let computerId = "";
  let commandId = "";
  let readRequestId = "";
  const sessionId = "synthetic_owned_native_session";
  const receipt = { status: "delivered", sessionId, workspaceId: WORKSPACE_ID, resultSummary: "Synthetic boundary receipt" };

  await step("before: registration is off by default even though the runner endpoints exist without Automations", async () => {
    const feature = await world.featureState();
    expect(feature).toMatchObject({ default: false, enabled: false });
    const registration = await world.register("owner");
    expect(registration).toMatchObject({ status: 404, body: { error: "feature_disabled" } });
    const automation = await world.api("owner", "/v1/automations");
    expect(automation.status).toBe(404);
    const work = await world.api("owner", "/v1/session-runners/work");
    expect(work).toMatchObject({ status: 401, body: { error: "runner_unauthorized" } });
    evidence.recordAssertionEvidence("The session protocol is mounted independently but cannot register before rollout", `Default=false, enabled=false; token HTTP ${registration.status} feature_disabled; session work HTTP ${work.status} runner_unauthorized (mounted); Automations HTTP ${automation.status}`, true);
  });

  await step("after: three owners can reuse the same install identity without sharing a computer", async () => {
    await world.rollout(true);
    const computers: string[] = [];
    for (const persona of ["owner", "otherMember", "otherOrg"]) {
      const registered = await world.register(persona);
      expect(registered.status, JSON.stringify(registered.body)).toBe(200);
      expect(world.rawRunnerId(persona)).toBe(SHARED_INSTALL_ID);
      expect((await world.inventory(persona)).status).toBe(200);
      const targets = await world.remote(persona, "targets", {});
      expect(targets.isError, JSON.stringify(targets.body)).toBe(false);
      const rows = records(targets.body.computers);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: "registered", online: true });
      computers.push(string(rows[0].computerId));
      expect((await world.work(persona))).toMatchObject({ status: 200, body: { items: [] } });
    }
    expect(new Set(computers).size).toBe(3);
    expect(computers).not.toContain(SHARED_INSTALL_ID);
    computerId = computers[0];
    evidence.recordAssertionEvidence("Computer identities are scoped, not installation-global", `Same raw install ${SHARED_INSTALL_ID}; 3 registrations, inventories and work reads HTTP 200 while Automations runtime is off; 3 distinct scoped computer ids; each identity sees only its own 1 registered target`, true);
  });

  await step("when the member queues a task, only its runner can claim and reclaim the same durable assignment", async () => {
    const created = await world.remote("owner", "create", { target: "registered", computerId, workspaceId: WORKSPACE_ID, title: "Scoped boundary task" });
    expect(created).toMatchObject({ isError: false, body: { state: "queued", computerId } });
    commandId = string(created.body.commandId);
    const first = await world.claim("owner", commandId);
    expect(first.status).toBe(200);
    expect(object(first.body).assignment).toMatchObject({ commandId, workspaceId: WORKSPACE_ID, prompt: null, model: null });
    expect((await world.work("owner")).body).toMatchObject({ items: [{ kind: "remote_session_create", commandId }] });
    expect((await world.work("otherMember")).body).toMatchObject({ items: [] });
    expect((await world.work("otherOrg")).body).toMatchObject({ items: [] });
    const renewed = await world.register("owner");
    expect(renewed.status).toBe(200);
    const recovered = await world.claim("owner", commandId);
    expect(recovered).toEqual(first);
    const wrongMember = await world.claim("otherMember", commandId);
    const wrongOrg = await world.claim("otherOrg", commandId);
    expect(wrongMember.status).toBe(409);
    expect(wrongOrg.status).toBe(409);
    evidence.recordAssertionEvidence("A sticky claim is recoverable only by its original owner", `Owner claim and renewed-token reclaim HTTP 200 with identical assignment; recovery work lists the same command; other member and other org see 0 work items and each claim returns HTTP 409`, true);
  });

  await step("then a reused install cannot forge a completion and the owner's terminal receipt is immutable", async () => {
    const wrongMember = await world.complete("otherMember", commandId, receipt);
    const wrongOrg = await world.complete("otherOrg", commandId, receipt);
    expect(wrongMember).toMatchObject({ status: 409, body: { error: "command_complete_conflict" } });
    expect(wrongOrg).toMatchObject({ status: 409, body: { error: "command_complete_conflict" } });
    const owned = await world.complete("owner", commandId, receipt);
    expect(owned).toMatchObject({ status: 200, body: { command: { id: commandId, status: "delivered", sessionId } } });
    const duplicate = await world.complete("owner", commandId, receipt);
    expect(duplicate).toEqual(owned);
    const mismatch = await world.complete("owner", commandId, { ...receipt, sessionId: "synthetic_different_native_session" });
    expect(mismatch).toMatchObject({ status: 409, body: { error: "command_complete_conflict" } });
    const wrongReport = await world.report("otherOrg", commandId, { status: "idle", engine: "v2", messageCount: 0, observedAt: Date.now() });
    expect(wrongReport.status).toBe(404);
    const report = await world.report("owner", commandId, { status: "idle", engine: "v2", messageCount: 0, observedAt: Date.now() });
    expect(report.status).toBe(200);
    const read = await world.remote("owner", "read", { commandId });
    expect(read).toMatchObject({ isError: false, body: { state: "delivered", computerId, sessionId, session: { status: "idle", engine: "v2" } } });
    evidence.recordAssertionEvidence("Organization and member checks still apply to terminal retries", `Other org/member completion HTTP 409; owner's original and identical replay HTTP 200; changed terminal session HTTP 409; wrong-org progress HTTP 404; owner progress HTTP 200; durable read retains ${sessionId} and scoped computer ${computerId}`, true);
  });

  await step("after: a scoped target's session can be read and stopped through the raw runner that owns it", async () => {
    const readPromise = world.remote("owner", "read", { sessionId, workspaceId: WORKSPACE_ID, from: "end", limit: 20 });
    const readRequest = await pendingRequest(world, probe);
    readRequestId = readRequest;
    const readClaim = await world.claimRequest("owner", readRequest);
    expect(readClaim.status).toBe(200);
    expect(object(readClaim.body).assignment).toMatchObject({ commandId, sessionId, workspaceId: WORKSPACE_ID, action: "read", engine: "v2" });
    const wrongOrg = await world.claimRequest("otherOrg", readRequest);
    const wrongMember = await world.claimRequest("otherMember", readRequest);
    expect(wrongOrg.status).toBe(409);
    expect(wrongMember.status).toBe(409);
    const recovered = await world.claimRequest("owner", readRequest);
    expect(recovered).toEqual(readClaim);
    const completed = await world.completeRequest("owner", readRequest, { status: "done", outcome: { action: "read", result: emptyTranscript() } });
    expect(completed.status).toBe(200);
    const read = await readPromise;
    const collected = read.body.state === "pending" ? await world.remote("owner", "read", { requestId: readRequest }) : read;
    expect(collected).toMatchObject({ isError: false, body: { state: "done", sessionId, status: "idle", messages: [] } });
    const stopPromise = world.remote("owner", "stop", { sessionId, workspaceId: WORKSPACE_ID });
    const stopRequest = await pendingRequest(world, probe);
    expect((await world.claimRequest("owner", stopRequest)).status).toBe(200);
    expect((await world.completeRequest("owner", stopRequest, { status: "done", outcome: { action: "stop", result: { stopped: false, reason: null } } })).status).toBe(200);
    const stop = await stopPromise;
    const stopped = stop.body.state === "pending" ? await world.remote("owner", "read", { requestId: stopRequest }) : stop;
    expect(stopped).toMatchObject({ isError: false, body: { stopped: false, reason: null } });
    evidence.recordAssertionEvidence("Raw runner ownership and scoped discovery agree for control", `MCP selected ${computerId}; native receipt belongs to raw ${SHARED_INSTALL_ID}; read/stop requests claimed and completed HTTP 200 and returned the wire client's empty recent context/idle stop; owner read reclaim HTTP 200, other org/member request claims HTTP 409`, true);
  });

  await step("a different member cannot read the command, collect its control result, or find it in history", async () => {
    const unknown = await world.remote("otherMember", "read", { commandId });
    const crossOrg = await world.remote("otherOrg", "read", { commandId });
    expect(unknown).toMatchObject({ isError: true, body: { error: "unknown_command" } });
    expect(crossOrg).toMatchObject({ isError: true, body: { error: "unknown_command" } });
    const control = await world.remote("otherMember", "read", { requestId: readRequestId });
    const crossOrgControl = await world.remote("otherOrg", "read", { requestId: readRequestId });
    expect(control).toMatchObject({ isError: true, body: { error: "unknown_request" } });
    expect(crossOrgControl).toMatchObject({ isError: true, body: { error: "unknown_request" } });
    const foreign = await world.remote("otherMember", "list", { target: "registered" });
    expect(records(foreign.body.sessions)).toEqual([]);
    const foreignStop = await world.remote("otherMember", "stop", { sessionId, workspaceId: WORKSPACE_ID });
    expect(foreignStop.isError).toBe(true);
    const own = await world.remote("owner", "list", { target: "registered" });
    expect(records(own.body.sessions).map(item => item.sessionId)).toEqual([sessionId]);
    evidence.recordAssertionEvidence("Remote history and control are private to the member and organization", `Owner lists 1 session; other member lists 0; other org/member command reads return unknown_command and completed request reads return unknown_request; other member stop=${foreignStop.body.error}`, true);
  });

  await step("after: killing the rollout drains an admitted claim but rejects any new offloaded work", async () => {
    const queued = await world.remote("owner", "create", { target: "registered", computerId, workspaceId: WORKSPACE_ID, title: "Already admitted before kill" });
    expect(queued.isError).toBe(false);
    const drainId = string(queued.body.commandId);
    expect((await world.claim("owner", drainId)).status).toBe(200);
    await world.rollout(true, true);
    expect((await world.claim("owner", drainId)).status).toBe(200);
    const drained = await world.complete("owner", drainId, { ...receipt, sessionId: "synthetic_drained_native_session" });
    expect(drained.status).toBe(200);
    const read = await world.remote("owner", "read", { commandId });
    expect(read).toMatchObject({ isError: false, body: { state: "delivered", sessionId } });
    const history = await world.remote("owner", "list", { target: "registered" });
    expect(records(history.body.sessions).map(item => item.sessionId)).toContain(sessionId);
    const create = await world.remote("owner", "create", { target: "registered", computerId, title: "Refused new work" });
    const send = await world.remote("owner", "send", { sessionId, prompt: "Must not be admitted after the kill." });
    for (const result of [create, send]) {
      expect(result.isError).toBe(true);
      expect(["feature_disabled", "unknown_capability"]).toContain(result.body.error);
      expect(result.body.commandId).toBeUndefined();
    }
    expect((await world.work("owner")).body).toMatchObject({ items: [] });
    evidence.recordAssertionEvidence("Kill switches refuse new effects without stranding admitted effects", `A pre-kill claim is reclaimed and completed HTTP 200 after kill; delivered command and registered history remain readable; create=${create.body.error}, send=${send.body.error}, neither has a commandId; runner work has 0 new commands`, true);
  });
});

presenceTest("a session-only member's connected computer is not counted as an Automation runner", async ({ world, step, evidence }) => {
  await step("before: no computer is available for the member's scheduled work", async () => {
    const result = await world.api("owner", "/v1/automation-runners/presence");
    expect(result).toMatchObject({ status: 200, body: { connected: false, lastSeenAt: null } });
    evidence.recordAssertionEvidence("Automation presence starts empty in a live scheduling runtime", `With Automations enabled, presence HTTP ${result.status}: connected=false, lastSeenAt=null`, true);
  });
  await step("when the member registers an interactive computer, it becomes a remote target only", async () => {
    await world.rollout(true);
    expect((await world.register("owner")).status).toBe(200);
    expect((await world.inventory("owner")).status).toBe(200);
    expect((await world.work("owner")).status).toBe(200);
    const target = await world.remote("owner", "targets", {});
    expect(records(target.body.computers)).toHaveLength(1);
    expect(records(target.body.computers)[0]).toMatchObject({ kind: "registered", online: true });
    evidence.recordAssertionEvidence("The interactive target is really connected", `Session-only token, inventory and work HTTP 200; targets has 1 online registered computer with remote_session_only_v1 and remote_session_recovery_v1`, true);
  });
  await step("after: remote-only presence never claims scheduled work can run", async () => {
    const presence = await world.api("owner", "/v1/automation-runners/presence");
    const targets = await world.api("owner", "/v1/automation-runners");
    expect(presence).toMatchObject({ status: 200, body: { connected: false, lastSeenAt: null } });
    expect(targets.status).toBe(200);
    expect(records(object(targets.body).items).filter(item => item.kind === "desktop")).toEqual([]);
    evidence.recordAssertionEvidence("An online offload client is not Automation capacity", `Automation presence HTTP 200: connected=false, lastSeenAt=null; Automation execution targets contain 0 desktops despite the online registered offload computer`, true);
  });
  await step("then a scheduling-capable desktop changes presence while the remote-only computer remains excluded", async () => {
    const registered = await world.register("owner", "synthetic_legacy_scheduler", { legacy: true, scheduling: true });
    expect(registered.status).toBe(200);
    const presence = await world.api("owner", "/v1/automation-runners/presence");
    expect(presence).toMatchObject({ status: 200, body: { connected: true } });
    const targets = await world.api("owner", "/v1/automation-runners");
    expect(records(object(targets.body).items).filter(item => item.kind === "desktop")).toHaveLength(1);
    evidence.recordAssertionEvidence("Presence is a live eligibility check, not an always-false response", `Released scheduling registration HTTP 200; presence becomes connected=true and exactly 1 scheduling desktop is listed (the session-only computer is still excluded)`, true);
  });
});

function emptyTranscript() {
  return { title: "Scoped boundary task", status: "idle", waitingFor: null, lastError: null, messageCount: 0, from: "end", messages: [], nextCursor: null };
}
async function pendingRequest(world: Awaited<ReturnType<typeof remoteSessionRegistration>>, probe: Probe) {
  const work = await probe.eventually(() => world.work("owner"), {
    within: 15_000, intervalMs: 100, label: "MCP control request addressed to the owner's raw runner",
    until: value => value.status === 200 && records(object(value.body).items).some(item => item.kind === "remote_session_request"),
  });
  const request = records(object(work.body).items).find(item => item.kind === "remote_session_request");
  return string(request?.requestId);
}
