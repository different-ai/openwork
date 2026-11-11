import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denMySessionsWorld } from "../worlds/den-my-sessions.ts";

const test = spec.world(denMySessionsWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("a member follows and answers sessions on their own computer from Den, only as far as the organization and the computer both allow", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.owner), member = user.on(world.member), memberProbe = probe.on(world.member);
  let computerId = "";
  const attachLocal = () => world.memberRequest("/v1/remote-sessions/attach", { computerId, workspaceId: world.workspaceId, sessionId: world.local.sessionId });
  const answered = (requestId: string) => probe.eventually(async () => (await memberProbe.dom(`[data-testid="session-pending-${requestId}"]`)).elements.length,
    { within: 60_000, until: (count) => count === 0, label: `the ${requestId} card goes away once the computer took the answer` });
  const errorOf = (body: unknown) => typeof body === "object" && body !== null && "error" in body ? String(body.error) : "";

  await step("by default a member's other devices reach only sessions that were started remotely", async () => {
    expect(await world.roles()).toEqual({ owner: "owner", manager: "admin", member: "member" });
    await member.see({ text: "Fieldnotes Studio" }, { timeoutMs: 60_000 });
    await member.click({ testId: "dashboard-nav-my-sessions" });
    await member.see({ role: "heading", label: "My Sessions" }, { timeoutMs: 60_000 });
    await member.see({ testId: "my-sessions-computers" });
    await member.see({ text: world.computer });
    await member.see({ text: "Only sessions started remotely" });
    await member.see({ text: world.remote.title });
    await member.notSee({ text: world.local.title });
    const list = await world.sessions();
    computerId = list.computers[0]?.computerId ?? "";
    expect(list.ceiling).toBe("created");
    expect(list.computers).toEqual([expect.objectContaining({ label: world.computer, supportsAccess: true, access: "created", effectiveAccess: "created" })]);
    expect(list.sessions.map((session) => [session.title, session.origin, session.reach])).toEqual([[world.remote.title, "remote", "reachable"]]);
    const refused = await attachLocal();
    expect(refused.response.status).toBe(409);
    expect(errorOf(refused.body)).toBe("session_access_denied");
    expect(new URL(await memberProbe.url()).pathname).toBe("/dashboard/my-sessions");
    evidence.recordAssertionEvidence("Default is the narrow policy", `ceiling=${list.ceiling}; computer access=${list.computers[0]?.access}; listed=${list.sessions.map((session) => session.title).join(", ")}; attach to a local session=${refused.response.status} ${errorOf(refused.body)}`, list.ceiling === "created" && list.sessions.length === 1 && refused.response.status === 409);
    await member.screenshot();
  });

  await step("an admin without the settings permission cannot widen it; the owner can, from Manage › Computers", async () => {
    const managerSettings = await world.settings("manager");
    const managerPatch = await world.managerRequest("/v1/org/remote-session-settings", { access: "all" }, "PATCH");
    const memberPatch = await world.memberRequest("/v1/org/remote-session-settings", { access: "all" }, "PATCH");
    expect(managerSettings).toEqual({ settings: { access: "created" }, canEdit: false });
    expect(managerPatch.response.status).toBe(403);
    expect(memberPatch.response.status).toBe(403);
    await owner.see({ text: "Manage" }, { timeoutMs: 60_000 });
    await owner.click({ testId: "dashboard-nav-computers" });
    await owner.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "session-access-setting" });
    await owner.see({ text: "Sessions other devices can reach" });
    await owner.screenshot();
    await owner.click({ testId: "session-access-select" });
    await owner.click({ testId: "session-access-all" });
    await probe.eventually(async () => (await world.settings("owner")).settings.access, { within: 30_000, until: (access) => access === "all", label: "the organization allows all sessions" });
    await owner.see({ text: "Saved" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("Only someone who may edit organization settings raises the ceiling", `admin canEdit=${managerSettings.canEdit}; admin PATCH=${managerPatch.response.status}; member PATCH=${memberPatch.response.status}; owner saved access=all in Manage › Computers`, managerPatch.response.status === 403 && memberPatch.response.status === 403);
    await owner.screenshot();
  });

  await step("the organization's choice alone opens nothing: the computer's owner has not turned it on", async () => {
    await probe.eventually(async () => (await world.sessions()).ceiling, { within: 30_000, until: (ceiling) => ceiling === "all", label: "the member's list sees the new ceiling" });
    const list = await world.sessions();
    const refused = await attachLocal();
    expect(list.computers[0]).toMatchObject({ access: "created", effectiveAccess: "created" });
    expect(list.sessions.map((session) => session.title)).toEqual([world.remote.title]);
    expect(refused.response.status).toBe(409);
    expect(errorOf(refused.body)).toBe("session_access_denied");
    await member.notSee({ text: world.local.title });
    evidence.recordAssertionEvidence("Both have to opt in", `ceiling=all; computer access=${list.computers[0]?.access}; local session listed=${list.sessions.some((session) => session.title === world.local.title)}; attach=${refused.response.status} ${errorOf(refused.body)}`, refused.response.status === 409 && list.sessions.length === 1);
  });

  await step("once Riley allows all sessions on the computer, the session started there appears and connects", async () => {
    world.setComputerChoice("all");
    await member.see({ text: world.local.title }, { timeoutMs: 60_000 });
    await member.see({ text: "Started on this computer" });
    await member.see({ text: "All sessions" });
    const list = await world.sessions();
    const local = list.sessions.find((session) => session.sessionId === world.local.sessionId);
    expect(local).toMatchObject({ origin: "local", reach: "attachable", commandId: null, state: "idle" });
    expect(list.computers[0]).toMatchObject({ access: "all", effectiveAccess: "all" });
    await member.screenshot();
    await member.click({ testId: `session-connect-${local?.key}` });
    await member.see({ testId: "session-panel" }, { timeoutMs: 90_000 });
    await member.see({ text: "Travel is 18% over plan. See https://example.com/budget for the table. I need a few answers before I export it." }, { timeoutMs: 60_000 });
    for (const item of [world.permission, world.scope, world.email]) await member.see({ testId: `session-pending-${item.requestId}` }, { timeoutMs: 60_000 });
    await member.see({ text: world.permission.command });
    await member.see({ text: "To always allow, answer on that computer." });
    const links = await memberProbe.dom('[data-testid="session-panel"] a[href*="example.com"]');
    const attached = (await world.sessions()).sessions.find((session) => session.sessionId === world.local.sessionId);
    expect(links.elements).toHaveLength(0);
    expect(attached).toMatchObject({ origin: "local", reach: "reachable", state: "waiting", waitingFor: "permission", commandId: world.attachedCommandId() });
    evidence.recordAssertionEvidence("Attach, then every open request is shown", `local session reach=${attached?.reach}; state=${attached?.state}; open cards=permission, a two-part question, a second question; remote text links rendered=${links.elements.length}`, attached?.reach === "reachable" && links.elements.length === 0);
    await member.screenshot();
  });

  await step("any open request can be answered, in any order: dismiss the last, answer the questions, then allow once", async () => {
    // Two question cards are open; the second Dismiss belongs to the last request.
    await member.click({ role: "button", label: "Dismiss", nth: 1 });
    await answered(world.email.requestId);
    await member.click({ text: "Full year" });
    await member.click({ text: "Design" });
    await member.type({ role: "textbox", label: "Other answer: Teams" }, "Field research");
    await member.screenshot();
    await member.click({ role: "button", label: "Send answer" });
    await answered(world.scope.requestId);
    await member.click({ role: "button", label: "Allow once" });
    await answered(world.permission.requestId);
    await probe.eventually(async () => world.answers().length, { within: 30_000, until: (count) => count === 3, label: "the computer received all three answers" });
    expect(world.answers()).toEqual([
      { kind: "dismiss", requestId: world.email.requestId },
      { kind: "question", requestId: world.scope.requestId, answers: [["Full year"], ["Design", "Field research"]] },
      { kind: "permission", requestId: world.permission.requestId, decision: "once" },
    ]);
    evidence.recordAssertionEvidence("The computer received exactly the member's answers", JSON.stringify(world.answers()), world.answers().length === 3);
    await member.type({ role: "textbox", label: "Follow-up message" }, "Also add the travel line to the summary.");
    await member.click({ role: "button", label: "Send" });
    await probe.eventually(async () => world.followUps(), { within: 60_000, until: (sent) => sent.length === 1, label: "the computer received the follow-up" });
    expect(world.followUps()).toEqual(["Also add the travel line to the summary."]);
    await member.see({ text: "Also add the travel line to the summary." }, { timeoutMs: 60_000 });
    await member.screenshot();
  });

  await step("none of this reaches another member, admin or owner", async () => {
    const manager = await world.sessions("manager"), ownerList = await world.sessions("owner");
    const foreignAttach = await world.managerRequest("/v1/remote-sessions/attach", { computerId, workspaceId: world.workspaceId, sessionId: world.local.sessionId });
    const foreignRead = await world.managerRequest("/v1/remote-sessions/read", { sessionId: world.local.sessionId, workspaceId: world.workspaceId, from: "end", limit: 5 });
    const ownerSend = await world.ownerRequest("/v1/remote-sessions/send", { sessionId: world.local.sessionId, workspaceId: world.workspaceId, prompt: "hello" });
    expect(manager.computers).toEqual([]);
    expect(manager.sessions).toEqual([]);
    expect(ownerList.sessions).toEqual([]);
    expect(foreignAttach.response.status).toBe(404);
    expect(errorOf(foreignAttach.body)).toBe("unknown_computer");
    expect(foreignRead.response.ok).toBe(false);
    expect(ownerSend.response.ok).toBe(false);
    expect(world.followUps()).toHaveLength(1);
    evidence.recordAssertionEvidence("Scoped to the member's own computers", `admin list=${manager.sessions.length} sessions, ${manager.computers.length} computers; owner list=${ownerList.sessions.length}; admin attach=${foreignAttach.response.status} ${errorOf(foreignAttach.body)}; admin read=${foreignRead.response.status}; owner send=${ownerSend.response.status}`, manager.sessions.length === 0 && foreignAttach.response.status === 404 && !foreignRead.response.ok && !ownerSend.response.ok);
  });

  await step("lowering the organization's ceiling closes the attached session at once; the remotely started task stays", async () => {
    await owner.click({ testId: "session-access-select" });
    await owner.click({ testId: "session-access-created" });
    await probe.eventually(async () => (await world.settings("owner")).settings.access, { within: 30_000, until: (access) => access === "created", label: "the organization is back to remotely started sessions" });
    const send = await world.memberRequest("/v1/remote-sessions/send", { sessionId: world.local.sessionId, workspaceId: world.workspaceId, prompt: "One more thing" });
    const list = await world.sessions();
    expect(send.response.status).toBe(409);
    expect(errorOf(send.body)).toBe("session_access_denied");
    expect(list.sessions.map((session) => [session.title, session.reach])).toEqual([[world.remote.title, "reachable"]]);
    expect(world.followUps()).toHaveLength(1);
    await member.navigate(world.url("/dashboard/my-sessions"));
    await member.see({ role: "heading", label: "My Sessions" }, { timeoutMs: 60_000 });
    await member.see({ text: world.remote.title }, { timeoutMs: 60_000 });
    await member.notSee({ text: world.local.title });
    await member.see({ text: "Your organization only allows sessions started remotely." });
    evidence.recordAssertionEvidence("The ceiling is enforced after attach", `send to the attached session=${send.response.status} ${errorOf(send.body)}; listed=${list.sessions.map((session) => session.title).join(", ")}; follow-ups the computer received=${world.followUps().length}`, send.response.status === 409 && list.sessions.length === 1);
    await member.screenshot();
  });

  await step("with the feature off the page and its routes are gone", async () => {
    await world.setEnabled(false);
    const list = await world.memberRequest("/v1/sessions");
    const settings = await world.ownerRequest("/v1/org/remote-session-settings");
    const refused = await attachLocal();
    expect(list.response.status).toBe(404);
    expect(settings.response.status).toBe(404);
    expect(refused.response.status).toBe(404);
    await member.reload();
    await member.see({ testId: "my-sessions-locked" }, { timeoutMs: 60_000 });
    await member.notSee({ testId: "dashboard-nav-my-sessions" });
    await owner.reload();
    await owner.see({ role: "heading", label: "Computers" }, { timeoutMs: 60_000 });
    await owner.notSee({ testId: "session-access-setting" });
    evidence.recordAssertionEvidence("Rollout gate", `remoteSessionAccess=false; sessions=${list.response.status}; settings=${settings.response.status}; attach=${refused.response.status}; My Sessions locked and its entry hidden; the setting is gone from Computers`, list.response.status === 404 && settings.response.status === 404 && refused.response.status === 404);
    await member.screenshot();
  });
});
