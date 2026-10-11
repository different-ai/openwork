import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Probe } from "@openwork/testkit";
import { object, records, string, opencodePluginRemoteSessions } from "../worlds/opencode-plugin-sign-in.ts";

const test = spec.world(opencodePluginRemoteSessions, {
  timeout: 900_000,
  needs: { commands: ["pnpm"] },
  resources: { surfaces: ["web"], services: ["den"] },
});

// The only browser is Den's real approval page. Session creation and observation
// use the installed, integrity-pinned OpenCode 2.0.26 service, never an adapter mock.
test("an opted-in OpenCode member offloads an empty native session, recovers a lost receipt, and keeps history when the rollout is killed", async ({ world, user, probe, step, evidence }) => {
  const person = user.on(world.web);
  let computerId = "";
  let workspaceId = "";
  let commandId = "";
  let sessionId = "";
  const title = "Remote native proof";

  await step("before: the rollout is off and an unsigned OpenCode directory registers nothing", async () => {
    const feature = await world.featureState();
    expect(feature).toMatchObject({ default: false, enabled: false, killed: false });
    const provenance = world.fixtureProvenance;
    expect(provenance.hostKind).toBe(world.web.handle.hostKind);
    expect(provenance.artifactSha).toMatch(/^[0-9a-f]{64}$/);
    expect(provenance.helperSourceSha).toMatch(/^[0-9a-f]{64}$/);
    if (provenance.hostKind === "daytona") {
      expect(provenance.sandboxId).toBeTruthy();
      expect(provenance.sandboxId).toBe(world.web.handle.sandboxId);
      expect(provenance.platform).toBe("linux-x64");
      expect(world.nativeWorkspaceDirectory).toMatch(/^\/tmp\/openwork-eval-native-opencode-/);
      expect(world.nativeWorkspaceDirectory.startsWith("/workspace/")).toBe(false);
    }
    const server = object(await world.native("/api/info"));
    expect(server.version).toBe("2.0.26");
    expect(typeof server.pid).toBe("number");
    const plugins = records(object(await world.nativePlugins()).data);
    const plugin = plugins.find(item => item.id === "openwork");
    expect(plugin, JSON.stringify(plugins)).toBeDefined();
    expect(object(plugin?.state).status).toBe("active");
    const unavailable = await world.remote("create", { target: "registered", title });
    expect(unavailable.isError).toBe(true);
    const requests = (await world.runnerWitness()).requests;
    expect(requests).toHaveLength(0);
    evidence.recordAssertionEvidence("Off by default means no registered directory", `OpenCode 2.0.26 PID ${server.pid} on ${provenance.hostKind}/${provenance.platform}, browser/native sandbox=${provenance.sandboxId ?? "local"}; current plugin artifact SHA-256 ${provenance.artifactSha}, source ${provenance.sourceSha}, verified helper ${provenance.helperSourceSha}; registry default=false, enabled=false; unsigned client made ${requests.length} runner requests; create refused with ${unavailable.body.error}`, true);
  });

  await step("when the owner enables offloading, OpenCode still waits for browser approval", async () => {
    await world.rollout(true);
    await world.setPluginSignIn(true);
    const login = await world.startLogin("browser");
    await person.navigate(login.verificationUrl);
    await person.see({ text: "Sign in OpenWork - OpenCode Plugin?" }, { timeoutMs: 90_000 });
    await person.see({ testId: "device-user-code", text: login.userCode });
    await person.see({ text: world.den.admin.email });
    const unsigned = await world.remote("targets", {});
    expect(unsigned.isError).toBe(false);
    expect(records(unsigned.body.computers)).toEqual([]);
    expect((await world.runnerWitness()).requests).toHaveLength(0);
    evidence.recordAssertionEvidence("Enabling the rollout is not approval of this machine", `Browser displays the terminal's code ${login.userCode}; targets has 0 computers and the plugin has made 0 runner requests before approval`, true);
    await person.screenshot();
    await person.click({ role: "button", label: "Sign in OpenWork - OpenCode Plugin" });
    await person.see({ text: "OpenCode is connected to OpenWork" }, { timeoutMs: 30_000 });
    const approved = await login.finished;
    expect(approved.status, approved.stdout).toBe(0);
  });

  await step("after: the approved native directory appears without Web access or Automations", async () => {
    const discovered = await world.searchRemote();
    expect(records(discovered.body.matches).some(item => item.name === "remote-session:targets")).toBe(true);
    const targets = await probe.eventually(() => world.remote("targets", { includeModels: true }), {
      within: 120_000, intervalMs: 1000, label: "approved OpenCode Location inventory",
      until: result => !result.isError && records(result.body.computers).some(item => item.kind === "registered" && item.online === true && Array.isArray(item.workspaces) && item.workspaces.length === 1),
    });
    const computers = records(targets.body.computers);
    expect(computers).toHaveLength(1);
    const computer = computers[0];
    computerId = string(computer.computerId);
    expect(computer).toMatchObject({ kind: "registered", label: "OpenCode proof computer", online: true, appVersion: "2.0.26" });
    const workspaces = records(computer.workspaces);
    expect(workspaces).toHaveLength(1);
    workspaceId = string(workspaces[0].workspaceId);
    expect(workspaces[0]).toMatchObject({ active: true, engine: "v2" });
    expect(workspaces[0].models).toBeInstanceOf(Array);
    const cloud = object(targets.body.cloud);
    expect(cloud.available).toBe(false);
    const automations = await world.automationRoute();
    expect(automations.status).toBe(404);
    const web = await world.webAccess();
    expect(web.status).toBe(404);
    expect(web.body).toMatchObject({ error: "openwork_web_not_available" });
    const witness = await world.runnerWitness();
    expect(witness.requests).toContainEqual({ method: "POST", path: "/v1/session-runners/token", status: 200 });
    expect(witness.requests).toContainEqual({ method: "PUT", path: "/v1/session-runners/inventory", status: 200 });
    evidence.recordAssertionEvidence("Only the approved directory is a native offload target", `1 registered computer (${computerId}), 1 active v2 workspace (${workspaceId}); native 2.0.26 inventory; session-runner token/inventory HTTP 200; Automations HTTP 404, Web HTTP 404 openwork_web_not_available, Cloud unavailable`, true);
    await person.screenshot();
  });

  await step("when the member creates an empty task, Den queues it and the native service creates exactly one session", async () => {
    const before = await world.nativeSessions();
    expect(before).toEqual([]);
    await world.disconnectAfterNextCompletion();
    const created = await world.remote("create", { target: "registered", computerId, workspaceId, title });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    expect(created.body).toMatchObject({ target: "registered", state: "queued", computerId, workspaceId });
    commandId = string(created.body.commandId);
    const delivered = await probe.eventually(() => world.remote("read", { commandId }), {
      within: 120_000, intervalMs: 1000, label: "durable native create receipt",
      until: result => !result.isError && ["delivered", "failed", "expired"].includes(String(result.body.state)),
    });
    expect(delivered.body, JSON.stringify(delivered.body)).toMatchObject({ state: "delivered", computerId, workspaceId, error: null });
    sessionId = string(delivered.body.sessionId);
    const native = await world.nativeSession(sessionId);
    expect(native).toMatchObject({ id: sessionId, title, location: { directory: world.directory } });
    const sessions = await world.nativeSessions();
    expect(sessions.map(item => item.id)).toEqual([sessionId]);
    const context = await world.nativeContext(sessionId);
    const inbox = await world.nativeInbox(sessionId);
    expect(context.filter(item => item.type === "user" || item.type === "assistant")).toEqual([]);
    expect(inbox).toEqual([]);
    evidence.recordAssertionEvidence("The receipt names a real native session, not a synthesized response", `MCP returned queued command ${commandId}; durable read delivered ${sessionId}; opencode api GET session/list/context/inbox on the same private service: exactly 1 titled session in the approved directory, 0 user/assistant messages and 0 queued inputs (no model inference)`, true);
  });

  await step("then the connection really loses the completion acknowledgement after Den stores it", async () => {
    const fault = await probe.eventually(() => world.runnerWitness(), {
      within: 30_000, intervalMs: 200, label: "lost receipt and runner link refusal",
      until: value => value.lostCompletionResponses === 1 && value.refusedRequests > 0,
    });
    expect(fault.lostCompletionResponses).toBe(1);
    const receipt = await world.remote("read", { commandId });
    expect(receipt.body).toMatchObject({ state: "delivered", sessionId });
    evidence.recordAssertionEvidence("The restart exercises an unacknowledged native effect", `Den accepted 1 real completion, its client saw a synthetic HTTP 503 instead, and ${fault.refusedRequests} later runner calls were refused; command remains delivered with ${sessionId}`, true);
  });

  await step("after: restarting the same service restores inventory and recent context without a duplicate task", async () => {
    const processBefore = object(await world.native("/api/info"));
    expect(typeof processBefore.pid).toBe("number");
    const inventoriesBefore = (await world.runnerWitness()).requests.filter(item => item.path === "/v1/session-runners/inventory" && item.status === 200).length;
    const completionsBefore = (await world.runnerWitness()).requests.filter(item => item.path === `/v1/remote-session-commands/${commandId}/complete` && item.status === 200).length;
    const restarted = await world.restartNativeService();
    const processAfter = object(await world.native("/api/info"));
    expect(processAfter.version).toBe("2.0.26");
    expect(typeof processAfter.pid).toBe("number");
    expect(processAfter.pid).not.toBe(processBefore.pid);
    expect(restarted.beforePid).toBe(processBefore.pid);
    expect(restarted.afterPid).toBe(processAfter.pid);
    await probe.eventually(() => world.runnerWitness(), {
      within: 120_000, intervalMs: 1000, label: "cold service re-registers and replays its receipt",
      until: value => value.requests.filter(item => item.path === "/v1/session-runners/inventory" && item.status === 200).length > inventoriesBefore
        && value.requests.filter(item => item.path === `/v1/remote-session-commands/${commandId}/complete` && item.status === 200).length > completionsBefore,
    });
    const targets = await world.remote("targets", {});
    expect(records(targets.body.computers).map(item => item.computerId)).toEqual([computerId]);
    const transcript = await collectRequest(world, probe, await world.remote("read", { sessionId, workspaceId, from: "end", limit: 20 }));
    expect(transcript.isError, JSON.stringify(transcript.body)).toBe(false);
    expect(transcript.body).toMatchObject({ state: "done", sessionId, workspaceId, title, status: "idle", messageCount: 0, from: "end", messages: [], nextCursor: null });
    const progress = await probe.eventually(() => world.remote("read", { commandId }), {
      within: 30_000, intervalMs: 1000, label: "native progress after replay",
      until: value => !value.isError && typeof value.body.session === "object" && value.body.session !== null,
    });
    expect(progress.body).toMatchObject({ state: "delivered", sessionId, computerId, session: { status: "idle", engine: "v2", messageCount: 0 } });
    const guardedStop = await collectRequest(world, probe, await world.remote("stop", { sessionId, workspaceId, messageId: "msg_unrelatedguard" }));
    expect(guardedStop).toMatchObject({ isError: false, body: { stopped: false, reason: "different_turn" } });
    expect((await world.nativeSessions()).map(item => item.id)).toEqual([sessionId]);
    evidence.recordAssertionEvidence("Cold restart reconciles the same receipt and directory", `service stop/start exits ${restarted.stopped}/${restarted.started}, native PID ${processBefore.pid} → ${processAfter.pid}; a fresh native inventory and a second HTTP 200 completion receipt; same computer ${computerId}, same session ${sessionId}, 1 native session; recent-context read is idle with 0 messages and no cursor; a mismatched turn guard returns stopped=false/different_turn`, true);
  });

  await step("a different member cannot discover, read, or control the member's native task", async () => {
    const targets = await world.remote("targets", {}, "other");
    const history = await world.remote("list", { target: "registered" }, "other");
    const receipt = await world.remote("read", { commandId }, "other");
    const read = await world.remote("read", { sessionId, workspaceId }, "other");
    const stop = await world.remote("stop", { sessionId, workspaceId }, "other");
    const create = await world.remote("create", { target: "registered", computerId, workspaceId, title: "Not the member's directory" }, "other");
    expect(records(targets.body.computers)).toEqual([]);
    expect(records(history.body.sessions)).toEqual([]);
    expect(receipt).toMatchObject({ isError: true, body: { error: "unknown_command" } });
    for (const result of [read, stop, create]) expect(result.isError, JSON.stringify(result.body)).toBe(true);
    expect((await world.nativeSessions()).map(item => item.id)).toEqual([sessionId]);
    evidence.recordAssertionEvidence("Another signed-in member owns no target or command from this machine", `Other member: 0 targets, 0 registered sessions; command read=${receipt.body.error}, session read=${read.body.error}, stop=${stop.body.error}, create=${create.body.error}; native service still has exactly the original session`, true);
  });

  await step("after: killing the rollout refuses new work but preserves history and safe stopping", async () => {
    await world.rollout(true, true);
    const feature = await world.featureState();
    expect(feature).toMatchObject({ killed: true });
    const create = await world.remote("create", { target: "registered", computerId, workspaceId, title: "Refused after kill" });
    const send = await world.remote("send", { sessionId, workspaceId, prompt: "This new turn must not be admitted." });
    for (const result of [create, send]) {
      expect(result.isError).toBe(true);
      expect(["feature_disabled", "unknown_capability"]).toContain(result.body.error);
      expect(result.body.commandId).toBeUndefined();
    }
    const history = await world.remote("list", { target: "registered" });
    expect(records(history.body.sessions).map(item => item.sessionId)).toEqual([sessionId]);
    const receipt = await world.remote("read", { commandId });
    expect(receipt.body).toMatchObject({ state: "delivered", sessionId });
    const transcript = await collectRequest(world, probe, await world.remote("read", { sessionId, workspaceId }));
    expect(transcript.body).toMatchObject({ state: "done", status: "idle", messages: [] });
    const stop = await collectRequest(world, probe, await world.remote("stop", { sessionId, workspaceId }));
    expect(stop.isError, JSON.stringify(stop.body)).toBe(false);
    expect(stop.body).toMatchObject({ stopped: false, reason: null });
    expect(await world.nativeInbox(sessionId)).toEqual([]);
    expect((await world.nativeContext(sessionId)).filter(item => item.type === "user")).toEqual([]);
    expect((await world.nativeSessions()).map(item => item.id)).toEqual([sessionId]);
    evidence.recordAssertionEvidence("A kill switch is not a history deletion or an abandoned task", `Killed=true; create=${create.body.error}, follow-up=${send.body.error}, neither has a commandId; list and command/recent-context reads retain ${sessionId}; stop acknowledges idle without interruption; 0 admitted prompts, 1 native session`, true);
  });
});

// Pending desktop-control receipts are part of the public MCP contract, not a
// reason to issue a second read/stop. Collect the original durable request only.
async function collectRequest(
  world: Awaited<ReturnType<typeof opencodePluginRemoteSessions>>,
  probe: Probe,
  first: Awaited<ReturnType<typeof world.remote>>,
) {
  if (first.body.state !== "pending") return first;
  const requestId = string(first.body.requestId);
  return probe.eventually(() => world.remote("read", { requestId }), {
    within: 90_000, intervalMs: 1000, label: "the original durable native control request",
    until: value => value.body.state !== "pending",
  });
}
