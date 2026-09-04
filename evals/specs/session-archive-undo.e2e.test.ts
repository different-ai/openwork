import { expect } from "vitest";
import type { Target } from "@openwork/cdp";
import { spec } from "@openwork/testkit";
import { archiveSessions } from "../worlds/session-shell.ts";

const test = spec.world(archiveSessions);

const archivedToast: Target = { text: "Session archived" };
const undoButton: Target = { role: "button", label: "Undo" };
const viewButton: Target = { role: "button", label: "View" };
const archiveMenuItem: Target = { role: "menuitem", label: "Archive session" };

test("archiving a session from the sidebar confirms quietly and can be undone", async ({ world, user, agent, probe, step }) => {
  const candidateId = world.candidate.sessionId;
  const neighborId = world.neighbor.sessionId;

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
    await user.notSee(archivedToast);
  });

  await step("archiving the candidate moves only it and offers a way back", async () => {
    await user.rightClick({ text: world.candidate.title });
    await user.see(archiveMenuItem);
    await user.click(archiveMenuItem);
    await user.see(archivedToast, { timeoutMs: 30_000 });
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
  });

  await step("Undo restores the candidate without announcing itself", async () => {
    await user.click(undoButton);
    await user.notSee(archivedToast, { timeoutMs: 15_000 });
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
    await user.notSee({ text: "Session unarchived" });
    await user.notSee(undoButton);
  });

  await step("View opens the archived session and leaves it archived", async () => {
    await user.rightClick({ text: world.candidate.title });
    await user.click(archiveMenuItem);
    await user.see(archivedToast, { timeoutMs: 30_000 });
    await user.click(viewButton);
    await probe.eventually(() => probe.hash(), {
      within: 30_000,
      label: "candidate session route opens from View",
      until: (hash) => hash.includes(`/session/${candidateId}`),
    });
    await user.notSee(archivedToast, { timeoutMs: 15_000 });
    const stamps = await world.archivedAt();
    expect(stamps[candidateId]).toBeGreaterThan(0);
    expect(stamps[neighborId]).toBe(0);
    expect((await world.sidebar()).archivedSection).toBe(true);
    await user.screenshot();
  });
});
