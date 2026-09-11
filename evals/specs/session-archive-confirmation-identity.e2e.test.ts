import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveActiveSessions } from "../worlds/session-shell.ts";

const test = spec.world(archiveActiveSessions, { timeout: 12 * 60_000 });

test("busy background archive identifies its captured target before consent and stops only that target", async ({ world, user, agent, probe, step }) => {
  const { a1, b1 } = world;
  const routeA = `#/workspace/${a1.workspaceId}/session/${a1.sessionId}`;
  const mutationRequests = async () => (await world.facts()).requests.filter(request => ["abort", "metadata"].includes(request.action));
  const beginArchive = () => {
    let settled = false;
    const result = agent.run("session.archive", { sessionId: b1.sessionId, archived: true })
      .catch((error: unknown) => error).finally(() => { settled = true; });
    return { result, settled: () => settled };
  };
  // The person just asked for this, so the confirmation stays simple: the
  // captured target's title, one question, two choices. Forensic detail
  // (workspace, id, requester) is not shown here.
  async function identify(title: string) {
    await user.see({ text: "This session is still working" });
    const dialog = await world.archiveConfirmation();
    expect(dialog.title).toBe(`This session is still working: ${title}`);
    expect(dialog.text).toContain("Stop the current task and archive?");
    expect(dialog.metadata).toEqual([]);
    expect(dialog.text).not.toContain(a1.sessionId);
    expect(dialog.text).not.toContain(b1.sessionId);
    expect(dialog.text).not.toContain("Requested by");
    expect(dialog.text).not.toContain(`/tmp/${world.workspaceBName}`);
    const description = await world.archiveAccessibleDescription();
    expect(description).toBe("Stop the current task and archive?");
    expect(dialog).toMatchObject({ titleUnclipped: true, fitsViewport: true, noHorizontalOverflow: true, contentReachable: true });
    expect(await probe.hash()).toBe(routeA);
  }

  await step("two independent real tasks run while A remains visible", async () => {
    for (const [index, target] of [b1, a1].entries()) {
      await agent.run("session.open", { sessionId: target.sessionId });
      await probe.eventually(() => world.surfaceReady(target.sessionId), { within: 30_000, label: "owning composer is ready" });
      await user.type("composer", `Keep ${target.title} running for confirmation identity proof.`, { replace: true });
      await user.press("Enter");
      await probe.eventually(() => world.requests(), { within: 60_000, label: "task reaches held provider", until: requests => requests.length === index + 1 });
    }
    expect(await probe.hash()).toBe(routeA);
    expect(await mutationRequests()).toEqual([]);
  });

  await step("programmatic B confirmation names B, remains pending, and Cancel changes neither task", async () => {
    const before = await world.facts();
    const transcript = await world.transcript(b1);
    const attempt = beginArchive();
    await identify(b1.title);
    expect((await world.archiveConfirmation()).text).not.toContain(a1.title);
    expect(attempt.settled()).toBe(false);
    expect(await mutationRequests()).toEqual([]);
    expect((await world.facts()).sessions).toEqual(before.sessions);
    await user.screenshot();
    await user.click({ role: "button", label: "Keep session open" });
    expect(await attempt.result).toMatchObject({ message: "Desktop control action session.archive failed: Session archive was cancelled or could not be confirmed" });
    await user.notSee({ text: "This session is still working" });
    expect((await world.facts()).sessions).toEqual(before.sessions);
    expect(await world.transcript(b1)).toEqual(transcript);
    expect(await mutationRequests()).toEqual([]);
    expect(await world.requests()).toHaveLength(2);
    expect(await probe.hash()).toBe(routeA);
  });

  for (const title of [a1.title, "", " \t ", `Long target ${"unbroken-identity".repeat(55)}`]) {
    const displayTitle = title.trim() || "New session";
    await step(`duplicate, blank or long target remains identifiable (${title === a1.title ? "duplicate" : title.trim() ? "long" : "blank"})`, async () => {
      await agent.run("session.open", { sessionId: b1.sessionId });
      await probe.eventually(() => world.surfaceReady(b1.sessionId), { within: 30_000, label: "title fixture owner is ready" });
      if (title.trim()) {
        await agent.run("session.rename", { sessionId: b1.sessionId, title });
      } else {
        // Legacy blank titles require the native API. Observe their owning
        // workspace's live update before returning to background-target proof.
        expect(await agent.desktopApi(`/workspace/${b1.workspaceId}/opencode/session/${b1.sessionId}`, { method: "PATCH", body: { title } })).toMatchObject({ status: 200 });
      }
      await user.see({ testId: `sidebar-session-${b1.sessionId}` }, { text: displayTitle });
      await agent.run("session.open", { sessionId: a1.sessionId });
      await probe.eventually(() => probe.hash(), { within: 30_000, label: "A is visible before background archive", until: hash => hash === routeA });
      const before = await mutationRequests();
      const attempt = beginArchive();
      await identify(displayTitle);
      if (title.startsWith("Long")) {
        await world.resize(390, 844);
        await identify(displayTitle);
        await user.screenshot();
        await world.resize(1280, 800);
      }
      expect(attempt.settled()).toBe(false);
      expect(await mutationRequests()).toEqual(before);
      await user.click({ role: "button", label: "Keep session open" });
      expect(await attempt.result).toBeInstanceOf(Error);
      expect(await mutationRequests()).toEqual(before);
      expect((await world.facts()).sessions.filter(session => [a1.sessionId, b1.sessionId].includes(session.sessionId))
        .every(session => !session.archived && session.status !== "idle")).toBe(true);
    });
  }

  await step("confirmed stop awaits B's engine, preserves A, and Undo restores B without restarting", async () => {
    await agent.run("session.open", { sessionId: b1.sessionId });
    await probe.eventually(() => world.surfaceReady(b1.sessionId), { within: 30_000, label: "title fixture owner is ready" });
    await agent.run("session.rename", { sessionId: b1.sessionId, title: b1.title });
    await user.see({ testId: `sidebar-session-${b1.sessionId}` }, { text: b1.title });
    await agent.run("session.open", { sessionId: a1.sessionId });
    await probe.eventually(() => world.surfaceReady(a1.sessionId), { within: 30_000, label: "A remains visible during confirmation" });
    const before = await mutationRequests();
    const aTranscript = await world.transcript(a1);
    const attempt = beginArchive();
    await identify(b1.title);
    expect(await mutationRequests()).toEqual(before);
    await world.networkFault("hold", b1.sessionId);
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ role: "button", label: "Stopping..." });
    await probe.eventually(() => mutationRequests(), { within: 15_000, label: "B stop reaches engine boundary", until: requests => requests.some(request => request.action === "abort") });
    expect(attempt.settled()).toBe(false);
    expect((await world.facts()).sessions.find(session => session.sessionId === b1.sessionId)).toMatchObject({ archived: false });
    expect(await probe.hash()).toBe(routeA);
    await world.releaseAbort();
    await world.networkFault("none", b1.sessionId);
    expect(await attempt.result).toEqual({ ok: true, sessionId: b1.sessionId, archived: true });
    await user.notSee({ text: "This session is still working" });
    await user.see({ text: `Session archived: ${b1.title}` });
    const stopped = await world.facts();
    expect(stopped.sessions.find(session => session.sessionId === b1.sessionId)).toMatchObject({ archived: true, status: "idle" });
    expect(stopped.sessions.find(session => session.sessionId === a1.sessionId)).toMatchObject({ archived: false, status: "busy" });
    expect(stopped.surfaces).toContain(a1.sessionId);
    expect(stopped.tabs).toContain(a1.sessionId);
    expect(stopped.tabs).not.toContain(b1.sessionId);
    expect(stopped.requests.filter(request => request.action === "abort").every(request => request.path === `/workspace/${b1.workspaceId}/opencode/session/${b1.sessionId}/abort`)).toBe(true);
    expect((await mutationRequests()).slice(before.length).every(request => request.sessionId === b1.sessionId)).toBe(true);
    expect(await world.transcript(a1)).toEqual(aTranscript);
    expect(await probe.hash()).toBe(routeA);
    await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "Undo is ready" });
    await user.click({ role: "button", label: "Undo" });
    await probe.eventually(() => world.facts(), { within: 30_000, label: "Undo restores only B", until: facts => facts.sessions.find(session => session.sessionId === b1.sessionId)?.archived === false });
    const deadline = Date.now() + 12_000;
    await probe.eventually(async () => {
      expect(await world.requests()).toHaveLength(2);
      const facts = await world.facts();
      expect(facts.sessions.find(session => session.sessionId === b1.sessionId)).toMatchObject({ archived: false, status: "idle" });
      expect(facts.sessions.find(session => session.sessionId === a1.sessionId)).toMatchObject({ archived: false, status: "busy" });
      expect(await probe.hash()).toBe(routeA);
      return Date.now() >= deadline;
    }, { within: 20_000, label: "restoring B never restarts stopped work or navigates away from A" });
  });
});
