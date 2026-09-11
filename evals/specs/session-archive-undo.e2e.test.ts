import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { archiveSessions } from "../worlds/session-shell.ts";

const test = spec.world(archiveSessions);

const archivedToast: Target = { text: "Session archived" };
const undoButton: Target = { role: "button", label: "Undo" };
const viewButton: Target = { role: "button", label: "View" };

test("session archive is honest about availability and can be undone when supported", async ({ world, user, agent, probe, step }) => {
  const candidateId = world.candidate.sessionId;
  const neighborId = world.neighbor.sessionId;
  const candidateRow = { testId: `sidebar-session-${candidateId}` };
  const archiveButton: Target = { role: "button", label: "Archive session", testId: `session-archive-${candidateId}` };
  const archiveCandidate = async () => {
    await user.hover(candidateRow);
    await user.see(archiveButton);
    await user.click(archiveButton);
    await user.see(archivedToast, { timeoutMs: 30_000 });
    await probe.eventually(() => world.undoToastSettled(), {
      within: 10_000,
      label: "undo pill finishes sliding in",
      until: (settled) => settled,
    });
    expect(await world.archiveToast()).toMatchObject({
      text: `Session archived: ${world.candidate.title}`,
      fullTitle: `Session archived: ${world.candidate.title}`,
      fitsViewport: true,
      actionsInside: true,
    });
  };

  await step("both sessions are active and nothing is archived", async () => {
    await agent.run("session.open", { sessionId: neighborId });
    await probe.eventually(() => probe.hash(), {
      within: 60_000,
      label: "neighbor session route opens",
      until: (hash) => hash.includes(`/session/${neighborId}`),
    });
    const stamps = await probe.eventually(() => world.archivedAt(), {
      within: 30_000,
      label: "both sessions listed as active",
      until: (value) => value[candidateId] === 0 && value[neighborId] === 0,
    });
    expect(stamps[candidateId]).toBe(0);
    expect(stamps[neighborId]).toBe(0);
    const sidebar = await world.sidebar();
    expect(sidebar.active).toContain(candidateId);
    expect(sidebar.active).toContain(neighborId);
    expect(sidebar.archivedSection).toBe(false);
    await user.notSee({ testId: `workspace-conversation-count-${world.workspace.workspaceId}` });
    expect((await probe.dom('[data-sidebar-workspace-title][aria-description]')).elements).toHaveLength(0);
    await user.notSee(archivedToast);
  });

  if (world.engine === "v2") {
    await step("v2 archive is unavailable without changing either session or claiming success", async () => {
      await user.hover(candidateRow);
      await user.see(archiveButton);
      expect(await world.sidebar()).toMatchObject({
        archiveButtonDisabled: true,
        archiveButtonTitle: "Archiving and unarchiving are not available in the OpenCode v2 preview.",
      });
      await world.hoverArchiveButton();
      // Reference only: the button, not a native tooltip or context menu.
      await step("v2 disabled archive button", () => user.screenshot());
      expect(await agent.actions()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "session.archive", disabled: true })]));
      for (const archived of [true, false]) {
        await expect(agent.run("session.archive", { sessionId: candidateId, archived })).rejects.toThrow("Action is disabled");
      }
      const stamps = await world.archivedAt();
      expect(stamps[candidateId]).toBe(0);
      expect(stamps[neighborId]).toBe(0);
      const sidebar = await world.sidebar();
      expect(sidebar.active).toContain(candidateId);
      expect(sidebar.active).toContain(neighborId);
      expect(sidebar.archivedSection).toBe(false);
      await user.notSee(archivedToast);
      await user.notSee({ text: "Session unarchived" });
      await user.notSee(undoButton);
      await user.notSee({ text: "This session is still working" });
      expect(await world.mutationRequests()).toEqual([]);
    });
    return;
  }

  await step("archiving the candidate moves only it and offers a way back", async () => {
    await archiveCandidate();
    await user.see(undoButton);
    await user.see(viewButton);
    await user.screenshot();
    const stamps = await probe.eventually(() => world.archivedAt(), {
      within: 30_000,
      label: "candidate archived on the server",
      until: (value) => value[candidateId] > 0,
    });
    expect(stamps[candidateId]).toBeGreaterThan(0);
    expect(stamps[neighborId]).toBe(0);
    const sidebar = await probe.eventually(() => world.sidebar(), {
      within: 30_000,
      label: "candidate leaves the workspace tree for the Archived section",
      until: (value) => !value.active.includes(candidateId) && value.archivedSection,
    });
    expect(sidebar.active).not.toContain(candidateId);
    expect(sidebar.active).toContain(neighborId);
    expect(sidebar.archivedSection).toBe(true);
    await user.see({ role: "button", label: /^Archived\s*1$/ });
    await user.notSee({ testId: `workspace-conversation-count-${world.workspace.workspaceId}` });
  });

  await step("Undo restores the candidate without announcing itself", async () => {
    await user.click(undoButton);
    await user.notSee(archivedToast);
    const stamps = await probe.eventually(() => world.archivedAt(), {
      within: 30_000,
      label: "candidate active again on the server",
      until: (value) => value[candidateId] === 0,
    });
    expect(stamps[candidateId]).toBe(0);
    expect(stamps[neighborId]).toBe(0);
    const sidebar = await probe.eventually(() => world.sidebar(), {
      within: 30_000,
      label: "candidate back in the workspace tree with no Archived section",
      until: (value) => value.active.includes(candidateId) && !value.archivedSection,
    });
    expect(sidebar.active).toContain(candidateId);
    expect(sidebar.active).toContain(neighborId);
    expect(sidebar.archivedSection).toBe(false);
    await user.notSee({ role: "button", label: /^Archived\s*1$/ });
    await user.notSee({ testId: `workspace-conversation-count-${world.workspace.workspaceId}` });
    await user.notSee({ text: "Session unarchived" });
    await user.notSee(undoButton);
  });

  for (const title of ["Programmatic archive candidate", `Long archive candidate ${"identity-preserving-title-".repeat(30)}`, "", " \t "]) {
    const displayTitle = title.trim() || "New session";
    const titleKind = title === "" ? "empty" : !title.trim() ? "whitespace-only" : title.startsWith("Long") ? "long" : "named";
    await step(`programmatic nonfocused archive identifies the ${titleKind} target and Undo restores only that target`, async () => {
      if (title.trim()) {
        expect(await agent.run("session.rename", { sessionId: candidateId, title })).toMatchObject({ ok: true });
      } else {
        await agent.run("session.rename", { sessionId: candidateId, title: "Before blank title" });
        await user.see(candidateRow, { text: "Before blank title" });
        expect(await world.setCandidateTitle(title)).toBe(title);
        await user.see(candidateRow, { text: displayTitle });
      }
      expect(await agent.run("session.archive", { sessionId: candidateId, archived: true })).toMatchObject({ ok: true });
      await user.see({ text: `Session archived: ${displayTitle}` });
      await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "programmatic toast settles", until: Boolean });
      expect(await world.archiveToast()).toMatchObject({
        text: `Session archived: ${displayTitle}`,
        fullTitle: `Session archived: ${displayTitle}`,
        fitsViewport: true,
        actionsInside: true,
        ...(title.startsWith("Long") ? { truncated: true } : {}),
      });
      expect(await probe.hash()).toContain(`/session/${neighborId}`);
      const stamps = await world.archivedAt();
      expect(stamps[candidateId]).toBeGreaterThan(0);
      expect(stamps[neighborId]).toBe(0);
      await user.click(undoButton);
      await user.notSee(archivedToast);
      const restored = await probe.eventually(() => world.archivedAt(), {
        within: 30_000, label: "programmatic Undo restores candidate", until: value => value[candidateId] === 0,
      });
      expect(restored[neighborId]).toBe(0);
      expect(await probe.hash()).toContain(`/session/${neighborId}`);
    });
  }

  await step("programmatic View opens its named target rather than the focused neighbor", async () => {
    await agent.run("session.rename", { sessionId: candidateId, title: world.candidate.title });
    await agent.run("session.archive", { sessionId: candidateId, archived: true });
    await user.see({ text: `Session archived: ${world.candidate.title}` });
    await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "View toast settles", until: Boolean });
    await user.click(viewButton);
    await probe.eventually(() => probe.hash(), {
      within: 30_000, label: "programmatic View opens candidate", until: hash => hash.includes(`/session/${candidateId}`),
    });
    const stamps = await world.archivedAt();
    expect(stamps[candidateId]).toBeGreaterThan(0);
    expect(stamps[neighborId]).toBe(0);
    await agent.run("session.archive", { sessionId: candidateId, archived: false });
    await probe.eventually(() => world.archivedAt(), {
      within: 30_000, label: "candidate restored for manual View check", until: value => value[candidateId] === 0,
    });
    await user.see("composer", { editable: true });
    await agent.run("session.open", { sessionId: neighborId });
  });

  await step("View opens the archived session and leaves it archived", async () => {
    await archiveCandidate();
    await user.click(viewButton);
    await probe.eventually(() => probe.hash(), {
      within: 30_000,
      label: "candidate session route opens from View",
      until: (hash) => hash.includes(`/session/${candidateId}`),
    });
    await user.notSee(archivedToast);
    const stamps = await world.archivedAt();
    expect(stamps[candidateId]).toBeGreaterThan(0);
    expect(stamps[neighborId]).toBe(0);
    expect((await world.sidebar()).archivedSection).toBe(true);
    await user.see({ testId: "archived-session" });
    await user.see({ role: "button", label: "Restore" });
    await user.notSee("composer");
    expect(await agent.actions()).toEqual(expect.arrayContaining([expect.objectContaining({ id: "composer.send", disabled: true })]));
    await user.screenshot();
  });
});
