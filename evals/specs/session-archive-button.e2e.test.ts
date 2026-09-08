import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveSessions } from "../worlds/session-shell.ts";
import { awayFirstPrompt, awayQueuedPrompt } from "../worlds/chat.ts";

const test = spec.world(archiveSessions, { timeout: 12 * 60_000 });

test("archiving exits only the viewed conversation, and working sessions require a confirmed stop without replay", async ({ world, user, agent, probe, step }) => {
  const { a1, a2, b1 } = world;
  const route = (target: typeof a1) => `#/workspace/${target.workspaceId}/session/${target.sessionId}`;
  const start = (target: typeof a1) => `#/workspace/${target.workspaceId}/session`;
  const quickAction = (target: typeof a1) => ({ testId: `session-archive-${target.sessionId}` });
  const aborts = async () => (await world.facts()).requests.filter(request => request.action === "abort");
  const initial = await world.facts();
  const initialIds = initial.sessions.map(session => session.sessionId).sort();

  async function open(target: typeof a1) {
    await user.click({ testId: `sidebar-session-${target.sessionId}` });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "owning session opens", until: hash => hash === route(target) });
  }

  async function archive(target: typeof a1) {
    await user.hover({ testId: `sidebar-session-${target.sessionId}` });
    await user.click(quickAction(target));
  }

  async function archived(target: typeof a1, expected: boolean) {
    const facts = await probe.eventually(() => world.facts(), {
      within: 30_000, label: `${target.title} archived=${expected}`,
      until: facts => facts.sessions.find(session => session.sessionId === target.sessionId)?.archived === expected
        && facts.activeRows.includes(target.sessionId) !== expected,
    });
    expect(facts.sessions.find(session => session.sessionId === target.sessionId)?.workspaceId).toBe(target.workspaceId);
    expect(facts.sessions.map(session => session.sessionId).sort()).toEqual(initialIds);
    return facts;
  }

  await step("idle active archive returns to the same workspace without creating a session; Undo reopens without sending", async () => {
    await open(a2);
    await archive(a2);
    await user.see("Session archived");
    await user.notSee("This session is still working");
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "same workspace start", until: hash => hash === start(a2) });
    const facts = await archived(a2, true);
    expect(facts.surfaces).not.toContain(a2.sessionId);
    expect(facts.tabs).not.toContain(a2.sessionId);
    expect(facts.memory[a2.workspaceId]).not.toBe(a2.sessionId);
    expect(facts.sessions.find(session => session.sessionId === a1.sessionId)?.archived).toBe(false);
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "Undo reopens idle session", until: hash => hash === route(a2) });
    expect(world.requests).toHaveLength(0);
    expect(await aborts()).toHaveLength(0);
  });

  await step("inactive cross-workspace archive and Undo leave the selected conversation unchanged", async () => {
    await open(b1);
    await open(a2);
    await archive(b1);
    await user.see("Session archived");
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
    expect(world.requests).toHaveLength(0);
  });

  await step("Undo restores metadata but does not steal navigation after the user opens another conversation", async () => {
    await archive(a2);
    await archived(a2, true);
    await open(a1);
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    expect(await probe.hash()).toBe(route(a1));
    expect(world.requests).toHaveLength(0);
  });

  for (const mode of ["retry", "permission", "question"] satisfies Array<"retry" | "permission" | "question">) {
    await step(`${mode} work requires confirmation and cancel leaves metadata and navigation untouched`, async () => {
      await world.networkFault(mode, a2.sessionId);
      await archive(a2);
      await user.see("This session is still working");
      await user.see("Stop the current task and archive this conversation? Changes already made won’t be undone. Actions already submitted to external services may still complete.");
      await user.click({ role: "button", label: "Keep session open" });
      await world.networkFault("none", a2.sessionId);
      await archived(a2, false);
      expect(await probe.hash()).toBe(route(a1));
      expect(await aborts()).toHaveLength(0);
    });
  }

  await step("a running task with queued work is not stopped or archived by cancelling either entry point", async () => {
    await open(b1);
    await user.type("composer", "Keep the other workspace task running for archive isolation proof.");
    await user.press("Enter");
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "other workspace task held", until: count => count === 1 });
    await open(a1);
    await user.type("composer", awayFirstPrompt);
    await user.press("Enter");
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "held provider receives task", until: count => count === 2 });
    await user.type("composer", awayQueuedPrompt);
    await user.press("Enter");
    await user.see({ text: awayQueuedPrompt });
    await archive(a1);
    await user.see("This session is still working");
    await user.click({ role: "button", label: "Keep session open" });
    await archived(a1, false);
    await user.see({ text: awayQueuedPrompt });
    expect(await aborts()).toHaveLength(0);
    expect(world.requests).toHaveLength(2);
    const controlAttempt = agent.run("session.archive", { sessionId: a1.sessionId, archived: true }).catch((error: unknown) => error);
    await user.see("This session is still working");
    await user.click({ role: "button", label: "Keep session open" });
    expect(await controlAttempt).toMatchObject({
      message: "Desktop control action session.archive failed: Session archive was cancelled or could not be confirmed",
    });
    await archived(a1, false);
    expect(await aborts()).toHaveLength(0);
    expect(await probe.hash()).toBe(route(a1));
  });

  await archive(a1);
  for (const mode of ["false", "error", "timeout", "unconfirmed"] satisfies Array<"false" | "error" | "timeout" | "unconfirmed">) {
    await step(`abort ${mode} leaves the session accessible and unarchived with a retryable dialog`, async () => {
      const before = (await aborts()).length;
      await world.networkFault(mode, a1.sessionId);
      await user.click({ role: "button", label: "Stop and archive" });
      await probe.eventually(async () => (await aborts()).length, { within: 20_000, label: `abort ${mode} attempted`, until: count => count === before + 1 });
      await user.see({ role: "button", label: "Stop and archive" }, { timeoutMs: 25_000 });
      await user.see({ text: /could not be confirmed|Injected abort connection failure|Request timed out/ });
      const facts = await archived(a1, false);
      expect(await probe.hash()).toBe(route(a1));
      expect(facts.surfaces).toContain(a1.sessionId);
      expect(facts.sessions.find(session => session.sessionId === a1.sessionId)?.status).not.toBe("idle");
      expect(facts.sessions.find(session => session.sessionId === b1.sessionId)?.archived).toBe(false);
      expect(world.requests).toHaveLength(2);
    });
  }

  await step("Stopping keeps the transcript accessible until the owning engine confirms stop; Undo never replays the cancelled queue", async () => {
    await world.networkFault("hold", a1.sessionId);
    const before = (await aborts()).length;
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see({ role: "button", label: "Stopping…" });
    await probe.eventually(async () => (await aborts()).length, { within: 15_000, label: "abort held before engine", until: count => count === before + 1 });
    const stopping = await archived(a1, false);
    expect(stopping.surfaces).toContain(a1.sessionId);
    expect(await probe.hash()).toBe(route(a1));
    await world.releaseAbort();
    await user.see("Session archived", { timeoutMs: 30_000 });
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
    await probe.eventually(() => {
      expect(world.requests).toHaveLength(2);
      return Date.now() >= deadline;
    }, { within: 15_000, label: "cancelled queue never drains in the background" });
    await open(a1);
    await user.notSee({ text: awayQueuedPrompt });
    expect(world.requests).toHaveLength(2);
    expect((await world.facts()).requests.filter(request => request.action === "prompt_async")).toHaveLength(2);
  });

  await step("stopping an unmounted working session uses its owning endpoint and leaves the viewed workspace unchanged", async () => {
    await open(a2);
    await world.networkFault("none", b1.sessionId);
    await archive(b1);
    await user.see("This session is still working");
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see("Session archived");
    const facts = await archived(b1, true);
    expect(await probe.hash()).toBe(route(a2));
    expect(facts.sessions.find(session => session.sessionId === b1.sessionId)?.status).toBe("idle");
    expect(facts.sessions.filter(session => session.workspaceId === a2.workspaceId).every(session => !session.archived)).toBe(true);
    expect((await aborts()).filter(request => request.sessionId === b1.sessionId).map(request => request.path)).toEqual([
      `/workspace/${b1.workspaceId}/opencode/session/${b1.sessionId}/abort`,
    ]);
    await user.click({ role: "button", label: "Undo" });
    await archived(b1, false);
    expect(await probe.hash()).toBe(route(a2));
    expect(world.requests).toHaveLength(2);
  });

  await step("a task finishing while its dialog is open can archive after fresh idle without aborting or restarting", async () => {
    await user.type("composer", "Finish this task while the archive dialog is open.");
    await user.press("Enter");
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "third task held", until: count => count === 3 });
    await archive(a2);
    await user.see("This session is still working");
    const before = (await aborts()).length;
    world.releaseRun();
    await probe.eventually(() => world.facts(), {
      within: 30_000, label: "task finished naturally in confirmation",
      until: facts => facts.sessions.find(session => session.sessionId === a2.sessionId)?.status === "idle",
    });
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see("Session archived");
    await archived(a2, true);
    expect(await probe.hash()).toBe(start(a2));
    expect(await aborts()).toHaveLength(before);
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    expect(world.requests).toHaveLength(3);
  });

  await step("a failed session archives directly; Undo restores it without retrying the failed send", async () => {
    await open(b1);
    await world.networkFault("prompt_error", b1.sessionId);
    await user.type("composer", "Fail this send for the archive journey.");
    await user.press("Enter");
    await user.see({ text: /Injected send failure/ });
    await world.networkFault("none", b1.sessionId);
    const before = (await aborts()).length;
    await archive(b1);
    await user.see("Session archived");
    await user.notSee("This session is still working");
    await archived(b1, true);
    expect(await probe.hash()).toBe(start(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(b1, false);
    expect(await aborts()).toHaveLength(before);
    expect(world.requests).toHaveLength(3);
  });

  await step("completed ordinary sessions archive directly through control, retain their transcript, and reopen read-only until restored", async () => {
    await open(a2);
    const transcript = await world.transcript(a2);
    expect(transcript).toEqual(expect.arrayContaining([expect.objectContaining({ role: "user", text: "Finish this task while the archive dialog is open." })]));
    expect(await agent.run("session.archive", { sessionId: a2.sessionId, archived: true })).toEqual({ ok: true, sessionId: a2.sessionId, archived: true });
    await archived(a2, true);
    await user.notSee("This session is still working");
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
    expect(world.requests).toHaveLength(3);
    await user.notSee("Session archived", { timeoutMs: 15_000 });
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
    expect(world.requests).toHaveLength(3);
    await user.click({ role: "button", label: "Close settings" });
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
    await user.see("Session archived");
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
    await user.click({ role: "button", label: "Close settings" });
    await open(a2);
    expect(world.requests).toHaveLength(3);
  });

  await step("a global queued admission cannot archive before settling or requeue its late failure after Undo", async () => {
    world.holdRun();
    await open(a1);
    await user.type("composer", "Hold another task before the late queued admission.");
    await user.press("Enter");
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "fourth task held", until: count => count === 4 });
    await user.type("composer", "This queued admission must never be replayed.");
    await user.press("Enter");
    await user.see("This queued admission must never be replayed.");
    await open(b1);
    await world.networkFault("hold_prompt", a1.sessionId);
    const before = (await world.facts()).requests.filter(request => request.action === "prompt_async").length;
    world.releaseRun();
    await probe.eventually(() => world.facts(), {
      within: 30_000, label: "unmounted queue starts an admission that remains unconfirmed",
      until: facts => facts.requests.filter(request => request.action === "prompt_async").length === before + 1,
    });
    await archive(a1);
    await user.see("This session is still working");
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see("Stopping could not be confirmed. The session has not been archived. Try again.", { timeoutMs: 25_000 });
    await archived(a1, false);
    expect(await probe.hash()).toBe(route(b1));
    await world.releaseAbort();
    await world.networkFault("none", a1.sessionId);
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see("Session archived");
    await archived(a1, true);
    expect(await probe.hash()).toBe(route(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a1, false);
    await open(a1);
    await user.notSee("This queued admission must never be replayed.");
    const deadline = Date.now() + 12_000;
    await probe.eventually(async () => {
      expect(world.requests).toHaveLength(4);
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
      await user.see("Session archived");
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
    expect(world.requests).toHaveLength(4);
  });

  await step("the last background queued run completes without leaving a false working confirmation", async () => {
    const before = world.requests.length;
    world.holdRun();
    await open(a2);
    await user.type("composer", "Background completion initial task.");
    await user.press("Enter");
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "background task starts", until: count => count === before + 1 });
    await user.type("composer", "Background completion last queued task.");
    await user.press("Enter");
    await user.see("Background completion last queued task.");
    await open(b1);
    world.releaseRun();
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "last queued task reaches provider", until: count => count === before + 2 });
    await probe.eventually(() => world.facts(), {
      within: 30_000, label: "background queue finishes",
      until: facts => facts.sessions.find(session => session.sessionId === a2.sessionId)?.status === "idle",
    });
    const transcript = await world.transcript(a2);
    await archive(a2);
    await user.see("Session archived");
    await user.notSee("This session is still working");
    await archived(a2, true);
    expect(await probe.hash()).toBe(route(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a2, false);
    expect(await world.transcript(a2)).toEqual(transcript);
    expect(world.requests).toHaveLength(before + 2);
  });

  await step("an idle parent stops its independently running child and cancels child queues, but archives only the parent", async () => {
    const before = world.requests.length;
    const beforeAborts = (await aborts()).length;
    world.holdRun();
    await agent.run("session.open", { sessionId: world.child.sessionId });
    await user.see("composer", { editable: true });
    await user.type("composer", "Independent child work for archive proof.");
    await user.press("Enter");
    await probe.eventually(() => world.requests.length, { within: 60_000, label: "child task held", until: count => count === before + 1 });
    await user.type("composer", "Cancelled child follow-up must not replay.");
    await user.press("Enter");
    await user.see("Cancelled child follow-up must not replay.");
    await open(b1);
    await archive(a1);
    await user.see("This session is still working");
    await user.click({ role: "button", label: "Keep session open" });
    expect(await aborts()).toHaveLength(beforeAborts);
    await archive(a1);
    await user.click({ role: "button", label: "Stop and archive" });
    await user.see("Session archived");
    const facts = await archived(a1, true);
    expect(facts.sessions.find(session => session.sessionId === world.child.sessionId)).toMatchObject({ archived: false, status: "idle" });
    expect((await aborts()).slice(beforeAborts).map(request => request.sessionId)).toEqual([world.child.sessionId]);
    expect(await probe.hash()).toBe(route(b1));
    await user.click({ role: "button", label: "Undo" });
    await archived(a1, false);
    world.releaseRun();
    await agent.run("session.open", { sessionId: world.child.sessionId });
    await user.notSee("Cancelled child follow-up must not replay.");
    expect(world.requests).toHaveLength(before + 1);
  });

  for (const queued of [false, true]) {
    await step(`${queued ? "queued" : "direct"} accepted commands cannot archive before their engine admission is observed`, async () => {
      await open(a2);
      const before = world.requests.length;
      const beforeAborts = (await aborts()).length;
      if (queued) {
        world.holdRun();
        await user.type("composer", "Hold the run before queueing an archive command.");
        await user.press("Enter");
        await probe.eventually(() => world.requests.length, { within: 60_000, label: "command predecessor held", until: count => count === before + 1 });
      }
      await world.networkFault("accepted_command", a2.sessionId);
      const commandCount = (await world.facts()).requests.filter(request => request.action === "command").length;
      await agent.run("composer.set_text", { text: "/archive-witness" });
      if (queued) {
        await user.press("Escape");
        await user.press("Enter");
        await open(b1);
        world.releaseRun();
      } else {
        await agent.run("composer.send");
      }
      await probe.eventually(() => world.facts(), {
        within: 30_000, label: "proxy command accepted before upstream dispatch",
        until: facts => facts.requests.filter(request => request.action === "command").length === commandCount + 1,
      });
      await archive(a2);
      await user.see("This session is still working");
      await user.click({ role: "button", label: "Stop and archive" });
      await user.see("Stopping could not be confirmed. The session has not been archived. Try again.", { timeoutMs: 25_000 });
      await archived(a2, false);
      expect(await aborts()).toHaveLength(beforeAborts);
      expect(world.requests).toHaveLength(before + Number(queued));
      world.holdRun();
      await world.releaseAbort();
      await world.networkFault("none", a2.sessionId);
      await probe.eventually(() => world.requests.length, { within: 60_000, label: "accepted command finally dispatched", until: count => count === before + Number(queued) + 1 });
      await user.click({ role: "button", label: "Stop and archive" });
      await user.see("Session archived");
      await archived(a2, true);
      await user.click({ role: "button", label: "Undo" });
      await archived(a2, false);
      world.releaseRun();
      expect(world.requests).toHaveLength(before + Number(queued) + 1);
      expect((await aborts()).slice(beforeAborts).map(request => request.sessionId)).toEqual([a2.sessionId]);
    });
  }
});
