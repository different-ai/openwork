import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveActiveSessions } from "../worlds/session-shell.ts";
import { awayFirstPrompt, awayQueuedPrompt } from "../worlds/chat.ts";

const test = spec.world(archiveActiveSessions, { timeout: 12 * 60_000 });

test("archiving exits only the viewed conversation, and working sessions require a confirmed stop without replay", async ({ world, user, agent, probe, step }) => {
  const { a1, a2, b1, faultCandidate } = world;
  const route = (target: typeof a1) => `#/workspace/${target.workspaceId}/session/${target.sessionId}`;
  const start = (target: typeof a1) => `#/workspace/${target.workspaceId}/session`;
  const quickAction = (target: typeof a1) => ({ testId: `session-archive-${target.sessionId}` });
  const aborts = async () => (await world.facts()).requests.filter(request => request.action === "abort");
  const initial = await world.facts();
  const initialIds = initial.sessions.map(session => session.sessionId).sort();
  const unsentDraft = "Keep this unsent draft when I cancel archiving.";

  async function open(target: typeof a1) {
    await user.click({ testId: `sidebar-session-${target.sessionId}` });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "owning session opens", until: hash => hash === route(target) });
    await probe.eventually(() => world.facts(), { within: 30_000, label: "owning surface mounts", until: facts => facts.surfaces.includes(target.sessionId) });
    await user.see("composer", { editable: true });
  }

  async function send(target: typeof a1, text: string, expectedRequests?: number) {
    const before = { target, diagnostics: await world.diagnostics(), facts: await world.facts() };
    try {
      expect(await probe.hash()).toBe(route(target));
      await probe.eventually(() => world.surfaceReady(target.sessionId), { within: 30_000, label: "composer snapshot belongs to the mounted send target" });
      await user.type("composer", text, { replace: true });
      await user.see("composer", { text });
      await user.press("Enter");
      await user.see({ text });
      if (expectedRequests !== undefined) {
        await probe.eventually(async () => ({ requests: await world.requests(), transcript: await world.transcript(target) }), {
          within: 60_000, label: `${target.title} reaches the held provider and owning transcript`,
          until: result => result.requests.length === expectedRequests && result.transcript.some(message => message.role === "user" && message.text.includes(text)),
        });
      }
    } catch (error) {
      console.info("[archive send:failure]", JSON.stringify({ before, diagnostics: await world.diagnostics(), facts: await world.facts(), provider: await world.requests() }));
      await user.screenshot();
      throw error;
    }
  }

  async function archive(target: typeof a1) {
    await user.hover({ testId: `sidebar-session-${target.sessionId}` });
    await user.click(quickAction(target));
  }

  async function archived(target: typeof a1, expected: boolean) {
    const facts = await probe.eventually(() => world.facts(), {
      within: 30_000, label: `${target.title} archived=${expected}`,
      until: facts => facts.sessions.find(session => session.sessionId === target.sessionId)?.archived === expected
        && facts.activeRows.includes(target.sessionId) !== expected
        && (!expected || !facts.tabs.includes(target.sessionId)),
    });
    expect(facts.sessions.find(session => session.sessionId === target.sessionId)?.workspaceId).toBe(target.workspaceId);
    expect(facts.sessions.map(session => session.sessionId).sort()).toEqual(initialIds);
    if (expected) await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "View/Undo toast entrance settles" });
    return facts;
  }

  await step("idle active archive returns to the same workspace without creating a session; Undo reopens without sending", async () => {
    await open(a2);
    await archive(a2);
    await user.see({ text: "Session archived" });
    await user.notSee({ text: "This session is still working" });
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "same workspace start", until: hash => hash === start(a2) });
    const facts = await archived(a2, true);
    expect(facts.surfaces).not.toContain(a2.sessionId);
    expect(facts.tabs).not.toContain(a2.sessionId);
    expect(facts.memory[a2.workspaceId]).not.toBe(a2.sessionId);
    expect(facts.sessions.find(session => session.sessionId === a1.sessionId)?.archived).toBe(false);
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "Undo reopens idle session", until: hash => hash === route(a2) });
    expect(await world.requests()).toHaveLength(0);
    expect(await aborts()).toHaveLength(0);
  });

  await step("inactive cross-workspace archive and Undo leave the selected conversation unchanged", async () => {
    await open(b1);
    await open(a2);
    await archive(b1);
    await user.see({ text: "Session archived" });
    const facts = await archived(b1, true);
    expect(await probe.hash()).toBe(route(a2));
    expect(facts.surfaces).toContain(a2.sessionId);
    expect(facts.memory[b1.workspaceId]).not.toBe(b1.sessionId);
    expect(facts.sessions.filter(session => session.workspaceId === a2.workspaceId).every(session => !session.archived)).toBe(true);
    await user.click({ role: "button", label: world.workspaceBName });
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "workspace switch does not reopen archived memory", until: hash => hash === start(b1) });
    await open(a2);
    await user.click({ role: "button", label: "Undo" });
    await archived(b1, false);
    expect(await probe.hash()).toBe(route(a2));
    expect(await world.requests()).toHaveLength(0);
  });

  await step("Undo restores metadata but does not steal navigation after the user opens another conversation", async () => {
    await archive(a2);
    await archived(a2, true);
    await open(a1);
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    expect(await probe.hash()).toBe(route(a1));
    expect(await world.requests()).toHaveLength(0);
  });

  for (const mode of ["retry", "permission", "question"] satisfies Array<"retry" | "permission" | "question">) {
    await step(`${mode} work requires confirmation and cancel leaves metadata and navigation untouched`, async () => {
      await world.networkFault(mode, faultCandidate.sessionId);
      const observations = await world.faultObservation();
      for (const observation of observations) {
        if (observation.workspaceId !== faultCandidate.workspaceId || observation.endpoint !== (mode === "retry" ? "session/status" : mode)) {
          expect(observation.observed).toEqual(observation.actual);
        } else if (mode === "retry") {
          expect(observation.observed).toEqual({ ...observation.actual, [faultCandidate.sessionId]: expect.objectContaining({ type: "retry" }) });
        } else {
          expect(observation.observed).toEqual([...observation.actual, expect.objectContaining({ sessionID: faultCandidate.sessionId })]);
        }
      }
      await archive(faultCandidate);
      await user.see({ text: "This session is still working" });
      await user.see({ text: "Stop the current task and all its subtasks, cancel queued messages, and archive this conversation? Changes already made won't be undone. Actions already submitted to external services may still complete." });
      await user.click({ role: "button", label: "Keep session open" });
      await world.networkFault("none", faultCandidate.sessionId);
      for (const observation of await world.faultObservation()) expect(observation.observed).toEqual(observation.actual);
      await archived(faultCandidate, false);
      expect(await probe.hash()).toBe(route(a1));
      expect(await aborts()).toHaveLength(0);
    });
  }

  await step("a running task with queued work is not stopped or archived by cancelling either entry point", async () => {
    await open(b1);
    await send(b1, "Keep the other workspace task running for archive isolation proof.", 1);
    await open(a1);
    await send(a1, awayFirstPrompt, 2);
    await send(a1, awayQueuedPrompt);
    await user.see({ text: awayQueuedPrompt });
    await user.type("composer", unsentDraft);
    const transcript = await world.transcript(a1);
    await archive(a1);
    await user.see({ text: "This session is still working" });
    await user.click({ role: "button", label: "Keep session open" });
    await archived(a1, false);
    await user.see({ text: awayQueuedPrompt });
    await user.see("composer", { text: unsentDraft });
    expect(await world.transcript(a1)).toEqual(transcript);
    expect(await aborts()).toHaveLength(0);
    expect(await world.requests()).toHaveLength(2);
    const controlAttempt = agent.run("session.archive", { sessionId: a1.sessionId, archived: true }).catch((error: unknown) => error);
    await user.see({ text: "This session is still working" });
    await user.click({ role: "button", label: "Keep session open" });
    expect(await controlAttempt).toMatchObject({
      message: "Desktop control action session.archive failed: Session archive was cancelled or could not be confirmed",
    });
    await archived(a1, false);
    await user.see({ text: awayQueuedPrompt });
    await user.see("composer", { text: unsentDraft });
    expect(await world.transcript(a1)).toEqual(transcript);
    expect(await aborts()).toHaveLength(0);
    expect(await probe.hash()).toBe(route(a1));
  });

  await archive(a1);
  for (const mode of ["false", "error", "timeout", "unconfirmed"] satisfies Array<"false" | "error" | "timeout" | "unconfirmed">) {
    await step(`abort ${mode} leaves the session accessible and unarchived with a retryable dialog`, async () => {
      const before = (await aborts()).length;
      await world.networkFault(mode, a1.sessionId);
      await user.click({ role: "button", label: "Stop and archive" });
      await probe.eventually(async () => (await aborts()).length, { within: 20_000, label: `abort ${mode} attempted`, until: count => count > before });
      await user.see({ role: "button", label: "Stop and archive" }, { timeoutMs: 25_000 });
      await user.see({ text: /The session has not been archived/ });
      const facts = await archived(a1, false);
      expect(await probe.hash()).toBe(route(a1));
      expect(facts.surfaces).toContain(a1.sessionId);
      expect(facts.sessions.find(session => session.sessionId === a1.sessionId)?.status).not.toBe("idle");
      expect(facts.sessions.find(session => session.sessionId === b1.sessionId)?.archived).toBe(false);
      expect((await aborts()).slice(before).every(request => request.path === `/workspace/${a1.workspaceId}/opencode/session/${a1.sessionId}/abort`)).toBe(true);
      expect(facts.requests.filter(request => request.action === "metadata" && request.sessionId === a1.sessionId)).toHaveLength(0);
      expect(await world.requests()).toHaveLength(2);
    });
  }

  await step("Stopping keeps the transcript accessible until the owning engine confirms stop; Undo never replays the cancelled queue", async () => {
    await world.networkFault("hold", a1.sessionId);
    const before = (await aborts()).length;
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ role: "button", label: "Stopping..." });
    await probe.eventually(async () => (await aborts()).length, { within: 15_000, label: "abort held before engine", until: count => count > before });
    const stopping = await archived(a1, false);
    expect(stopping.surfaces).toContain(a1.sessionId);
    expect(stopping.sessions.find(session => session.sessionId === a1.sessionId)?.status).not.toBe("idle");
    expect(await probe.hash()).toBe(route(a1));
    await world.releaseAbort();
    await world.networkFault("none", a1.sessionId);
    await user.see({ text: "Session archived" }, { timeoutMs: 30_000 });
    const stopped = await archived(a1, true);
    expect(stopped.sessions.find(session => session.sessionId === a1.sessionId)?.status).toBe("idle");
    expect(stopped.sessions.find(session => session.sessionId === b1.sessionId)?.status).not.toBe("idle");
    expect(stopped.surfaces).not.toContain(a1.sessionId);
    expect(stopped.tabs).not.toContain(a1.sessionId);
    expect((await aborts()).every(request => request.path.includes(`/workspace/${a1.workspaceId}/`) && request.sessionId === a1.sessionId)).toBe(true);
    expect(await probe.hash()).toBe(start(a1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a1, false);
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "Undo reopens stopped transcript", until: hash => hash === route(a1) });
    await user.notSee({ text: awayQueuedPrompt });
    // Cross the drain's observation timeout while unmounted, then remount.
    await open(b1);
    const deadline = Date.now() + 12_000;
    await probe.eventually(async () => {
      expect(await world.requests()).toHaveLength(2);
      return Date.now() >= deadline;
    }, { within: 15_000, label: "cancelled queue never drains in the background" });
    await open(a1);
    await user.notSee({ text: awayQueuedPrompt });
    expect(await world.requests()).toHaveLength(2);
    expect((await world.facts()).requests.filter(request => request.action === "prompt_async")).toHaveLength(2);
  });

  await step("stopping an unmounted working session uses its owning endpoint and leaves the viewed workspace unchanged", async () => {
    await open(a2);
    await world.networkFault("none", b1.sessionId);
    await archive(b1);
    await user.see({ text: "This session is still working" });
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ text: "Session archived" });
    const facts = await archived(b1, true);
    expect(await probe.hash()).toBe(route(a2));
    expect(facts.sessions.find(session => session.sessionId === b1.sessionId)?.status).toBe("idle");
    expect(facts.sessions.filter(session => session.workspaceId === a2.workspaceId).every(session => !session.archived)).toBe(true);
    const targetedAborts = (await aborts()).filter(request => request.sessionId === b1.sessionId);
    expect(targetedAborts.length).toBeGreaterThan(0);
    expect(targetedAborts.every(request => request.path === `/workspace/${b1.workspaceId}/opencode/session/${b1.sessionId}/abort`)).toBe(true);
    await user.click({ role: "button", label: "Undo" });
    await archived(b1, false);
    expect(await probe.hash()).toBe(route(a2));
    expect(await world.requests()).toHaveLength(2);
  });

  await step("a task finishing while its dialog is open can archive after fresh idle even with a false abort acknowledgment, without restarting", async () => {
    await send(a2, "Finish this task while the archive dialog is open.", 3);
    await archive(a2);
    await user.see({ text: "This session is still working" });
    const before = (await aborts()).length;
    await world.releaseRun();
    await probe.eventually(() => world.facts(), {
      within: 30_000, label: "task finished naturally in confirmation",
      until: facts => facts.sessions.find(session => session.sessionId === a2.sessionId)?.status === "idle",
    });
    expect(await world.transcript(a2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: a2.sessionId, role: "assistant", text: "Archive fixture reply.", completed: expect.any(Number) }),
    ]));
    await world.networkFault("false", a2.sessionId);
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ text: "Session archived" });
    await archived(a2, true);
    expect(await probe.hash()).toBe(start(a2));
    expect((await aborts()).slice(before).every(request => request.path === `/workspace/${a2.workspaceId}/opencode/session/${a2.sessionId}/abort`)).toBe(true);
    expect((await aborts()).slice(before).some(request => request.result === "false")).toBe(true);
    await world.networkFault("none", a2.sessionId);
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    expect(await world.requests()).toHaveLength(3);
  });

  await step("a failed session archives directly; Undo restores it without retrying the failed send", async () => {
    await open(b1);
    await world.networkFault("prompt_error", b1.sessionId);
    await send(b1, "Fail this send for the archive journey.");
    await user.see({ text: /Injected send failure/ });
    await world.networkFault("none", b1.sessionId);
    const before = (await aborts()).length;
    await archive(b1);
    await user.see({ text: "Session archived" });
    await user.notSee({ text: "This session is still working" });
    await archived(b1, true);
    expect(await probe.hash()).toBe(start(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(b1, false);
    expect(await aborts()).toHaveLength(before);
    expect(await world.requests()).toHaveLength(3);
  });

  await step("completed ordinary sessions archive directly through control, retain their transcript, and reopen read-only until restored", async () => {
    await open(a2);
    const transcript = await world.transcript(a2);
    expect(transcript).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", text: "Finish this task while the archive dialog is open." })]));
    expect(await agent.run("session.archive", { sessionId: a2.sessionId, archived: true })).toEqual({ ok: true, sessionId: a2.sessionId, archived: true });
    await archived(a2, true);
    await user.notSee({ text: "This session is still working" });
    await agent.run("session.open", { sessionId: a2.sessionId });
    await user.see({ testId: "archived-session" });
    await user.notSee("composer");
    expect(await agent.actions()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "composer.send", disabled: true })]));
    expect(await world.transcript(a2)).toEqual(transcript);
    expect(await agent.run("session.archive", { sessionId: a2.sessionId, archived: false })).toEqual({ ok: true, sessionId: a2.sessionId, archived: false });
    await archived(a2, false);
    await user.notSee({ testId: "archived-session" });
    await user.see("composer", { editable: true });

    await archive(a2);
    await archived(a2, true);
    await agent.run("session.open", { sessionId: a2.sessionId });
    await user.see({ testId: "archived-session" });
    await user.click({ role: "button", label: "Restore" });
    await archived(a2, false);
    await user.see("composer", { editable: true });
    expect(await world.transcript(a2)).toEqual(transcript);
    expect(await world.requests()).toHaveLength(3);
    await user.notSee({ text: "Session archived" }, { timeoutMs: 15_000 });
  });

  await step("Undo after leaving for Settings restores metadata without reviving the unmounted route", async () => {
    await archive(a2);
    await archived(a2, true);
    await agent.run("settings.panel.open", { panel: "general" });
    const settingsHash = await probe.eventually(() => probe.hash(), {
      within: 15_000, label: "Settings owns navigation", until: hash => hash.includes("/settings/"),
    });
    await user.click({ role: "button", label: "Undo" });
    await probe.eventually(() => world.facts(), {
      within: 15_000, label: "Undo restores metadata while Settings stays open",
      until: facts => facts.sessions.find(session => session.sessionId === a2.sessionId)?.archived === false,
    });
    expect(await probe.hash()).toBe(settingsHash);
    expect(await world.requests()).toHaveLength(3);
    await user.click({ role: "button", label: "Back to app" });
    await open(a2);
  });

  await step("an archive completing after route unmount cannot redirect away from Settings", async () => {
    await world.networkFault("hold_archive", a2.sessionId);
    await archive(a2);
    await probe.eventually(() => world.facts(), {
      within: 15_000, label: "archive metadata write held",
      until: facts => facts.requests.some(request => request.action === "metadata" && request.sessionId === a2.sessionId && request.result === null),
    });
    await agent.run("settings.panel.open", { panel: "general" });
    const settingsHash = await probe.hash();
    expect(settingsHash).toContain("/settings/");
    await world.releaseAbort();
    await world.networkFault("none", a2.sessionId);
    await user.see({ text: "Session archived" });
    expect(await probe.hash()).toBe(settingsHash);
    const facts = await world.facts();
    expect(facts.sessions.find(session => session.sessionId === a2.sessionId)?.archived).toBe(true);
    expect(facts.tabs).not.toContain(a2.sessionId);
    await user.click({ role: "button", label: "Undo" });
    await probe.eventually(() => world.facts(), {
      within: 15_000, label: "late archive Undo is metadata-only",
      until: facts => facts.sessions.find(session => session.sessionId === a2.sessionId)?.archived === false,
    });
    expect(await probe.hash()).toBe(settingsHash);
    await user.click({ role: "button", label: "Back to app" });
    await open(a2);
    expect(await world.requests()).toHaveLength(3);
  });

  await step("a global queued admission cannot archive before settling or requeue its late failure after Undo", async () => {
    await world.holdRun();
    await open(a1);
    await send(a1, "Hold another task before the late queued admission.", 4);
    await send(a1, "This queued admission must never be replayed.");
    await user.see({ text: "This queued admission must never be replayed." });
    await open(b1);
    await world.networkFault("hold_prompt", a1.sessionId);
    const before = (await world.facts()).requests.filter(request => request.action === "prompt_async").length;
    await world.releaseRun();
    await probe.eventually(() => world.facts(), {
      within: 30_000, label: "unmounted queue starts an admission that remains unconfirmed",
      until: facts => facts.requests.filter(request => request.action === "prompt_async").length === before + 1,
    });
    await archive(a1);
    await user.see({ text: "This session is still working" });
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ text: /The session has not been archived/ }, { timeoutMs: 25_000 });
    await archived(a1, false);
    expect(await probe.hash()).toBe(route(b1));
    await world.releaseAbort();
    await world.networkFault("none", a1.sessionId);
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ text: "Session archived" });
    await archived(a1, true);
    expect(await probe.hash()).toBe(route(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a1, false);
    await open(a1);
    await user.notSee({ text: "This queued admission must never be replayed." });
    const deadline = Date.now() + 12_000;
    await probe.eventually(async () => {
      expect(await world.requests()).toHaveLength(4);
      expect((await world.facts()).requests.filter(request => request.action === "prompt_async")).toHaveLength(before + 1);
      return Date.now() >= deadline;
    }, { within: 20_000, label: "late admission failure does not replay on restore" });
  });

  await step("archived split panes and tabs disappear, and archiving the routed pane never promotes its neighbor", async () => {
    await open(a2);
    const before = (await aborts()).length;
    for (const target of [b1, a2]) {
      await user.rightClick({ testId: `sidebar-session-${b1.sessionId}` });
      await user.click({ role: "menuitem", label: "Open in split view" });
      await probe.eventually(() => world.facts(), {
        within: 15_000, label: "both owning split surfaces render",
        until: facts => facts.surfaces.includes(a2.sessionId) && facts.surfaces.includes(b1.sessionId),
      });
      await archive(target);
      await user.see({ text: "Session archived" });
      const facts = await archived(target, true);
      expect(facts.surfaces).not.toContain(target.sessionId);
      expect(facts.tabs).not.toContain(target.sessionId);
      expect(await probe.hash()).toBe(target === a2 ? start(a2) : route(a2));
      if (target === a2) expect(facts.surfaces).not.toContain(b1.sessionId);
      else expect(facts.surfaces).toContain(a2.sessionId);
      await user.click({ role: "button", label: "Undo" });
      await archived(target, false);
      await probe.eventually(() => probe.hash(), { within: 15_000, label: "Undo leaves primary route restored", until: hash => hash === route(a2) });
    }
    expect(await aborts()).toHaveLength(before);
    expect(await world.requests()).toHaveLength(4);
  });

  await step("the last background queued run completes without leaving a false working confirmation", async () => {
    const before = (await world.requests()).length;
    await world.holdRun();
    await open(a2);
    await send(a2, "Background completion initial task.", before + 1);
    await send(a2, "Background completion last queued task.");
    await user.see({ text: "Background completion last queued task." });
    await open(b1);
    await world.releaseRun();
    await probe.eventually(async () => (await world.requests()).length, { within: 60_000, label: "last queued task reaches provider", until: count => count === before + 2 });
    await probe.eventually(() => world.facts(), {
      within: 30_000, label: "background queue finishes",
      until: facts => facts.sessions.find(session => session.sessionId === a2.sessionId)?.status === "idle",
    });
    const transcript = await world.transcript(a2);
    await archive(a2);
    await user.see({ text: "Session archived" });
    await user.notSee({ text: "This session is still working" });
    await archived(a2, true);
    expect(await probe.hash()).toBe(route(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    expect(await world.transcript(a2)).toEqual(transcript);
    expect(await world.requests()).toHaveLength(before + 2);
  });

  await step("an idle parent stops its independently running child and cancels child queues, but archives only the parent", async () => {
    const before = (await world.requests()).length;
    const beforeAborts = (await aborts()).length;
    await world.holdRun();
    await agent.run("session.open", { sessionId: world.child.sessionId });
    await user.see("composer", { editable: true });
    await send(world.child, "Independent child work for archive proof.", before + 1);
    await send(world.child, "Cancelled child follow-up must not replay.");
    await user.see({ text: "Cancelled child follow-up must not replay." });
    await open(b1);
    await archive(a1);
    await user.see({ text: "This session is still working" });
    await user.click({ role: "button", label: "Keep session open" });
    expect(await aborts()).toHaveLength(beforeAborts);
    await archive(a1);
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ text: "Session archived" });
    const facts = await archived(a1, true);
    expect(facts.sessions.find(session => session.sessionId === world.child.sessionId)).toMatchObject({ archived: false, status: "idle" });
    const ownedAborts = (await aborts()).slice(beforeAborts);
    expect(ownedAborts.some(request => request.sessionId === world.child.sessionId)).toBe(true);
    expect(ownedAborts.every(request => [a1.sessionId, world.child.sessionId].includes(request.sessionId)
      && request.path === `/workspace/${a1.workspaceId}/opencode/session/${request.sessionId}/abort`)).toBe(true);
    expect(await probe.hash()).toBe(route(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a1, false);
    await world.releaseRun();
    await agent.run("session.open", { sessionId: world.child.sessionId });
    await user.notSee({ text: "Cancelled child follow-up must not replay." });
    const deadline = Date.now() + 12_000;
    await probe.eventually(async () => {
      expect(await world.requests()).toHaveLength(before + 1);
      return Date.now() >= deadline;
    }, { within: 20_000, label: "restoring the parent never replays a descendant queue" });
  });

  for (const queued of [false, true]) {
    await step(`${queued ? "queued" : "direct"} accepted commands cannot archive before their engine admission is observed`, async () => {
      await open(a2);
      const before = (await world.requests()).length;
      const beforeAborts = (await aborts()).length;
      if (queued) {
        await world.holdRun();
        await send(a2, "Hold the run before queueing an archive command.", before + 1);
      }
      await world.networkFault("accepted_command", a2.sessionId);
      const commandCount = (await world.facts()).requests.filter(request => request.action === "command").length;
      await agent.run("composer.set_text", { text: "/archive-witness" });
      if (queued) {
        await user.press("Escape");
        await user.press("Enter");
        await send(a2, "The message after the accepted command must never replay.");
        await open(b1);
        await world.releaseRun();
      } else {
        await agent.run("composer.send");
      }
      const accepted = await probe.eventually(() => world.facts(), {
        within: 30_000, label: "proxy command accepted before upstream dispatch",
        until: facts => facts.requests.filter(request => request.action === "command").length === commandCount + 1,
      });
      const command = accepted.requests.filter(request => request.action === "command")[commandCount];
      expect(command).toMatchObject({ sessionId: a2.sessionId, path: `/workspace/${a2.workspaceId}/opencode/session/${a2.sessionId}/command`, result: "accepted, not dispatched" });
      expect(command.messageID).toMatch(/^msg_/);
      expect((await world.transcript(a2)).some(message => message.id === command.messageID)).toBe(false);
      await archive(a2);
      await user.see({ text: "This session is still working" });
      await user.click({ role: "button", label: "Stop and archive" });
      await user.see({ text: /The session has not been archived/ }, { timeoutMs: 25_000 });
      await archived(a2, false);
      expect(await world.requests()).toHaveLength(before + Number(queued));
      expect((await world.facts()).requests.filter(request => request.action === "metadata")).toHaveLength(accepted.requests.filter(request => request.action === "metadata").length);

      // A different run in the same engine session is not the command's admission.
      // It can go busy and then terminal while the acknowledged command is still held.
      await world.holdRun();
      await world.dispatchUnrelatedPrompt(a2);
      await probe.eventually(async () => ({ requests: await world.requests(), facts: await world.facts() }), {
        within: 60_000, label: "unrelated work goes busy without admitting the held command",
        until: value => value.requests.length === before + Number(queued) + 1 && value.facts.sessions.some(session => session.sessionId === a2.sessionId && session.status !== "idle"),
      });
      await user.click({ role: "button", label: "Stop and archive" });
      await user.see({ text: /The session has not been archived/ }, { timeoutMs: 25_000 });
      await archived(a2, false);
      expect((await world.transcript(a2)).some(message => message.id === command.messageID)).toBe(false);
      expect((await world.facts()).requests.filter(request => request.action === "metadata")).toHaveLength(accepted.requests.filter(request => request.action === "metadata").length);

      await world.holdRun();
      await world.releaseAbort();
      await world.networkFault("none", a2.sessionId);
      const expected = before + Number(queued) + 2;
      await probe.eventually(async () => ({ requests: await world.requests(), transcript: await world.transcript(a2) }), {
        within: 60_000, label: "exact accepted command reaches the engine and held provider",
        until: value => value.requests.length === expected && value.transcript.some(message => message.id === command.messageID && message.role === "user"),
      });
      await user.click({ role: "button", label: "Stop and archive" });
      await user.see({ text: "Session archived" });
      await archived(a2, true);
      const transcript = await world.transcript(a2);
      expect(transcript).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: command.messageID, sessionId: a2.sessionId, role: "user" }),
        expect.objectContaining({ parentID: command.messageID, sessionId: a2.sessionId, role: "assistant", completed: expect.any(Number), pendingTools: false }),
      ]));
      expect(transcript.find(message => message.role === "assistant" && message.parentID === command.messageID && message.completed !== null)?.finish).not.toBe("tool-calls");
      await user.click({ role: "button", label: "Undo" });
      await archived(a2, false);
      await world.releaseRun();
      await open(b1);
      const deadline = Date.now() + 12_000;
      await probe.eventually(async () => {
        expect(await world.requests()).toHaveLength(expected);
        expect((await world.facts()).requests.filter(request => request.action === "command")).toHaveLength(commandCount + 1);
        return Date.now() >= deadline;
      }, { within: 20_000, label: "unknown admission and its cancelled successor never replay after Undo" });
      await open(a2);
      await user.notSee({ text: "The message after the accepted command must never replay." });
      const stopped = (await aborts()).slice(beforeAborts);
      expect(stopped.length).toBeGreaterThan(0);
      expect(stopped.every(request => request.sessionId === a2.sessionId && request.path === `/workspace/${a2.workspaceId}/opencode/session/${a2.sessionId}/abort`)).toBe(true);
    });
  }
});
