import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveActiveSessions } from "../worlds/session-shell.ts";

const test = spec.world(archiveActiveSessions, { timeout: 12 * 60_000 });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

test("pinned idle sessions archive from the sidebar and mailbox without a focused session; held preflight fails promptly without a late PATCH and recovers", async ({ world, user, agent, probe, step, evidence }) => {
  const { a1, a2, b1, child, faultCandidate, workspaceA } = world;
  const root = `#/workspace/${workspaceA.workspaceId}/session`;
  const session = async (id: string) => (await world.facts()).sessions.find(entry => entry.sessionId === id);
  const listing = async (id: string): Promise<unknown> => {
    const entries = await agent.run("session.list_sessions");
    if (!Array.isArray(entries)) throw new Error("Session listing is not an array");
    return entries.find((entry: unknown) => isRecord(entry) && entry.sessionId === id);
  };
  const pin = async (id: string, pinned: boolean) => {
    expect(await agent.run("session.pin", { sessionId: id })).toMatchObject({ ok: true, sessionId: id, pinned });
    await probe.eventually(() => listing(id), {
      within: 10_000, label: "pin state is exposed to agents", until: entry => isRecord(entry) && entry.pinned === pinned,
    });
  };
  const mailbox = async (id: string, archived = true) => {
    const started = performance.now();
    const result = await agent.desktopApi("/experimental/ui-control/request", {
      method: "POST",
      body: { kind: "command", input: { id: "session.archive", args: { sessionId: id, archived }, origin: { sessionId: a1.sessionId } } },
    });
    return { ...result, elapsedMs: performance.now() - started };
  };
  const noSessionFocused = async () => {
    expect(await probe.hash()).toBe(root);
    expect((await world.facts()).surfaces).toEqual([]);
    await user.see({ text: "What should we work on?" });
  };
  const untouched = async () => {
    for (const target of [a1, child]) expect(await session(target.sessionId)).toMatchObject({ archived: false, status: "idle" });
    expect((await world.facts()).requests.filter(request => request.action === "abort")).toEqual([]);
    await user.notSee({ text: "This session is still working" });
    await noSessionFocused();
  };
  const archived = async (id: string, startedAt?: number) => {
    await probe.eventually(() => session(id), { within: 10_000, label: "archive persisted in the owning engine", until: entry => entry?.archived === true });
    if (startedAt !== undefined) expect(performance.now() - startedAt).toBeLessThan(5_000);
    await user.notSee({ testId: `sidebar-session-${id}` }, { timeoutMs: 10_000 });
    await untouched();
  };
  const clickArchive = async (id: string) => {
    await user.hover({ testId: `sidebar-session-${id}` });
    await user.click({ testId: `session-archive-${id}` });
  };

  await step("a pinned idle session archives through the UI while no conversation is focused", async () => {
    await noSessionFocused();
    await pin(a2.sessionId, true);
    await user.see({ text: "Pinned" });
    const started = performance.now();
    await clickArchive(a2.sessionId);
    await archived(a2.sessionId, started);
    expect(await session(b1.sessionId)).toMatchObject({ archived: false, status: "idle" });
    expect(await session(faultCandidate.sessionId)).toMatchObject({ archived: false, status: "idle" });
    evidence.recordAssertionEvidence("Pinned archive completes without a focused conversation", "Owning-engine archive persisted, sidebar row disappeared, unrelated sessions stayed idle/unarchived, no abort or dialog, route and surface list stayed sessionless.", true);
  });

  await step("a pinned idle session in another workspace archives through the real mailbox", async () => {
    await pin(b1.sessionId, true);
    const result = await mailbox(b1.sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, id: "session.archive", result: { ok: true, sessionId: b1.sessionId, archived: true } });
    expect(result.elapsedMs).toBeLessThan(5_000);
    await archived(b1.sessionId);
    expect(await session(faultCandidate.sessionId)).toMatchObject({ archived: false, status: "idle" });
    evidence.recordAssertionEvidence("Pinned cross-workspace archive completes through the real mailbox", `HTTP ${result.status}; elapsed ${result.elapsedMs} ms; persisted archive, no unrelated mutation, no navigation or dialog.`, true);
  });

  await step("unpin then archive also completes through the UI without opening a session", async () => {
    await pin(faultCandidate.sessionId, true);
    await pin(faultCandidate.sessionId, false);
    const started = performance.now();
    await clickArchive(faultCandidate.sessionId);
    await archived(faultCandidate.sessionId, started);
    evidence.recordAssertionEvidence("Unpin then archive also succeeds", "Candidate changed pinned:true to pinned:false, then archived through the UI with no focused conversation; unrelated sessions were preserved.", true);
  });

  await step("restore and pin the fault candidate without navigating", async () => {
    const result = await mailbox(faultCandidate.sessionId, false);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, result: { ok: true, sessionId: faultCandidate.sessionId, archived: false } });
    await probe.eventually(() => session(faultCandidate.sessionId), { within: 10_000, label: "candidate restored", until: entry => entry?.archived === false });
    await user.see({ testId: `sidebar-session-${faultCandidate.sessionId}` });
    await pin(faultCandidate.sessionId, true);
    await untouched();
  });

  await step("a held messages body returns structured verification_failed before the five-second mailbox deadline", async () => {
    await world.networkFault("hold_messages", faultCandidate.sessionId);
    const before = await world.facts();
    const result = await mailbox(faultCandidate.sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: false, id: "session.archive", code: "verification_failed", error: expect.any(String) });
    expect(result.elapsedMs).toBeLessThan(5_000);
    const after = await world.facts();
    expect(after.requests.slice(before.requests.length).filter(request => request.action === "messages"))
      .toEqual([expect.objectContaining({ sessionId: faultCandidate.sessionId, result: "held" })]);
    expect(after.requests.filter(request => request.action === "metadata")).toEqual(before.requests.filter(request => request.action === "metadata"));
    expect(after.sessions).toEqual(before.sessions);
    await user.see({ testId: `sidebar-session-${faultCandidate.sessionId}` });
    expect(await listing(faultCandidate.sessionId)).toMatchObject({ pinned: true });
    await untouched();
    evidence.recordAssertionEvidence("Held preflight fails through the requesting channel before five seconds", `HTTP ${result.status}; elapsed ${result.elapsedMs} ms; verification_failed; zero additional PATCHes or session mutations, pin retained.`, true);
  });

  await step("releasing the stalled read cannot send a late archive PATCH; a fresh mailbox request succeeds", async () => {
    const before = await world.facts();
    await world.releaseAbort();
    await world.networkFault("none", faultCandidate.sessionId);
    const releasedAt = performance.now();
    await probe.eventually(() => world.facts(), {
      within: 5_000, label: "released preflight stays inert for two seconds",
      until: facts => performance.now() - releasedAt >= 2_000 && facts.requests.some(request => request.action === "messages" && request.result === "released"),
    });
    const after = await world.facts();
    expect(after.requests.filter(request => request.action === "metadata")).toEqual(before.requests.filter(request => request.action === "metadata"));
    expect(after.sessions).toEqual(before.sessions);
    await untouched();
    const result = await mailbox(faultCandidate.sessionId);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, result: { ok: true, sessionId: faultCandidate.sessionId, archived: true } });
    expect(result.elapsedMs).toBeLessThan(5_000);
    await archived(faultCandidate.sessionId);
    const patches = (await world.facts()).requests.filter(request => request.action === "metadata");
    expect(patches.slice(before.requests.filter(request => request.action === "metadata").length))
      .toEqual([expect.objectContaining({ sessionId: faultCandidate.sessionId, result: 200 })]);
    evidence.recordAssertionEvidence("No late PATCH and no restart needed for mailbox recovery", `Released preflight stayed inert for two seconds. A new request on the same app/mailbox completed in ${result.elapsedMs} ms with exactly one successful PATCH; unrelated sessions and route unchanged.`, true);
  });
});
