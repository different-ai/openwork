import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveActiveSessions } from "../worlds/session-shell.ts";

const test = spec.world(archiveActiveSessions, { timeout: 12 * 60_000 });

// The OpenCode plugin delivers every agent command through the server mailbox
// with `origin` set to the requesting conversation; the desktop answers it via
// window.__openworkControl.command. This drives that exact path.
type Bridged = { status: number; body: unknown; elapsedMs: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

test("agents see which sessions are working, an agent's archive of a working session is refused through its own channel while the person keeps a simple confirmation, and session.stop is attributed", async ({ world, user, agent, probe, step }) => {
  const { a1, a2, b1 } = world;
  const routeA = `#/workspace/${a1.workspaceId}/session/${a1.sessionId}`;
  const aborts = async () => (await world.facts()).requests.filter(request => request.action === "abort");
  const session = async (id: string) => (await world.facts()).sessions.find(entry => entry.sessionId === id);
  const bridged = async (input: { id: string; args?: unknown; origin?: { sessionId: string } }): Promise<Bridged> => {
    const startedAt = Date.now();
    const response = await agent.desktopApi("/experimental/ui-control/request", { method: "POST", body: { kind: "command", input } });
    return { ...response, elapsedMs: Date.now() - startedAt };
  };
  const archiveVia = (origin: string, target: string) => bridged({ id: "session.archive", args: { sessionId: target, archived: true }, origin: { sessionId: origin } });

  await step("two independent real tasks run while A remains visible", async () => {
    for (const [index, target] of [b1, a1].entries()) {
      await agent.run("session.open", { sessionId: target.sessionId });
      await probe.eventually(() => world.surfaceReady(target.sessionId), { within: 30_000, label: "owning composer is ready" });
      await user.type("composer", `Keep ${target.title} running for requester proof.`, { replace: true });
      await user.press("Enter");
      await probe.eventually(() => world.requests(), { within: 60_000, label: "task reaches held provider", until: requests => requests.length === index + 1 });
    }
    expect(await probe.hash()).toBe(routeA);
    expect(await aborts()).toEqual([]);
  });

  await step("session.list_sessions tells agents which sessions are working before they touch them", async () => {
    const listed = await probe.eventually(() => agent.run("session.list_sessions"), {
      within: 30_000,
      label: "both running sessions report working",
      until: value => Array.isArray(value) && [a1, b1].every(target => value.some(entry => isRecord(entry) && entry.sessionId === target.sessionId && entry.working === true)),
    });
    if (!Array.isArray(listed)) throw new Error("list_sessions did not return a list");
    const byId = new Map(listed.filter(isRecord).map(entry => [entry.sessionId, entry]));
    for (const target of [a1, b1]) {
      expect(byId.get(target.sessionId)).toMatchObject({ working: true, status: expect.stringMatching(/^(thinking|responding)$/) });
    }
    expect(byId.get(a2.sessionId)).toMatchObject({ working: false, status: "idle" });
    // Agents learn the contract from the action descriptions they are handed.
    const actions = await agent.actions();
    if (!Array.isArray(actions)) throw new Error("listActions did not return a list");
    const describe = (id: string) => {
      const action = actions.find(entry => isRecord(entry) && entry.id === id);
      return isRecord(action) && typeof action.description === "string" ? action.description : "";
    };
    expect(describe("session.list_sessions")).toContain("`working`");
    expect(describe("session.archive")).toContain("target_working");
    expect(describe("session.archive")).toContain("self_archive_while_working");
    expect(describe("session.stop")).toContain("attributes the stop to you");
  });

  await step("an agent archiving another working session is refused with target_working: no dialog, no stop, no 5 s stall", async () => {
    const before = await world.facts();
    const result = await archiveVia(a2.sessionId, b1.sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: false,
      id: "session.archive",
      code: "target_working",
      error: expect.stringContaining(b1.title),
      hint: expect.stringContaining("call session.stop"),
    });
    // The old path stalled on a human dialog until the mailbox gave up after 5 s.
    expect(result.elapsedMs).toBeLessThan(5_000);
    await user.notSee({ text: "This session is still working" });
    expect(await session(b1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    expect(await aborts()).toEqual([]);
    expect((await world.facts()).sessions).toEqual(before.sessions);
    expect(await probe.hash()).toBe(routeA);
  });

  await step("a session archiving itself mid-turn is refused with self_archive_while_working, no dialog", async () => {
    const result = await archiveVia(a1.sessionId, a1.sessionId);
    expect(result.body).toMatchObject({
      ok: false,
      code: "self_archive_while_working",
      hint: expect.stringContaining("the reviewer archives"),
    });
    expect(result.elapsedMs).toBeLessThan(5_000);
    await user.notSee({ text: "This session is still working" });
    expect(await session(a1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    expect(await aborts()).toEqual([]);
  });

  await step("the person's own click keeps a simple confirmation: title, one question, Keep or Stop and archive", async () => {
    await user.hover({ testId: `sidebar-session-${b1.sessionId}` });
    await user.click({ testId: `session-archive-${b1.sessionId}` });
    await user.see({ text: "This session is still working" });
    const dialog = await world.archiveConfirmation();
    expect(dialog.title).toBe(`This session is still working: ${b1.title}`);
    expect(dialog.text).toContain("Stop the current task and archive?");
    expect(dialog.metadata).toEqual([]);
    expect(dialog.text).not.toContain("Requested by");
    expect(dialog.text).not.toContain(b1.sessionId);
    expect(dialog).toMatchObject({ titleUnclipped: true, fitsViewport: true, noHorizontalOverflow: true, contentReachable: true });
    await user.screenshot();
    await user.click({ role: "button", label: "Keep session open" });
    await user.notSee({ text: "This session is still working" });
    expect(await session(b1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    expect(await aborts()).toEqual([]);
    expect(await probe.hash()).toBe(routeA);

    // Idle bridged archive still completes without a dialog.
    const result = await archiveVia(a1.sessionId, a2.sessionId);
    expect(result.body).toMatchObject({ ok: true, id: "session.archive", result: { ok: true, sessionId: a2.sessionId, archived: true } });
    await user.notSee({ text: "This session is still working" });
    await probe.eventually(() => session(a2.sessionId), { within: 30_000, label: "idle neighbor is archived", until: entry => entry?.archived === true });
    expect(await session(a1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    expect(await session(b1.sessionId)).toMatchObject({ archived: false, status: "busy" });
  });

  await step("an agent stops a working other-session by id: its run ends, nothing navigates, and the notification names target and requester", async () => {
    const stopVia = (origin: string, target: string) => bridged({ id: "session.stop", args: { sessionId: target }, origin: { sessionId: origin } });
    expect(await session(b1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    const result = await stopVia(a1.sessionId, b1.sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, id: "session.stop", result: { ok: true, sessionId: b1.sessionId, title: b1.title, stopped: true } });
    await user.notSee({ text: "This session is still working" });
    await probe.eventually(() => session(b1.sessionId), { within: 30_000, label: "B's run ends", until: entry => entry?.status === "idle" });
    expect(await session(b1.sessionId)).toMatchObject({ archived: false, status: "idle" });
    expect(await session(a1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    const stops = await aborts();
    expect(stops.length).toBeGreaterThan(0);
    expect(stops.every(request => request.sessionId === b1.sessionId)).toBe(true);
    expect(await probe.hash()).toBe(routeA);

    const attribution = `Requested by The agent in "${a1.title}" ${a1.sessionId}`;
    await user.see({ text: `Session stopped: ${b1.title}` });
    await user.see({ text: attribution });
    await user.screenshot();
    const persisted = await probe.storage("openwork:notifications:v1");
    const entries = isRecord(persisted) && isRecord(persisted.state) && Array.isArray(persisted.state.notifications) ? persisted.state.notifications : [];
    expect(entries).toContainEqual(expect.objectContaining({
      kind: "system",
      title: `Session stopped: ${b1.title}`,
      body: attribution,
      action: { type: "open-session", workspaceId: b1.workspaceId, sessionId: b1.sessionId },
      actionLabel: "View",
    }));

    // Idempotent, and unknown ids are a structured error rather than a dialog.
    expect((await stopVia(a1.sessionId, b1.sessionId)).body).toMatchObject({ ok: true, result: { ok: true, sessionId: b1.sessionId, alreadyIdle: true } });
    expect((await stopVia(a1.sessionId, "ses_does_not_exist")).body).toMatchObject({ ok: false, error: "Session was not found in the current session list" });
    expect(await session(a1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    await user.notSee({ text: "This session is still working" });
  });
});
