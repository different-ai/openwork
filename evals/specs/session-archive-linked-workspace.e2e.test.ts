import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archiveSessionsInLinkedWorkspace } from "../worlds/session-shell.ts";

const test = spec.world(archiveSessionsInLinkedWorkspace, {
  timeout: 10 * 60_000,
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "The Electron main process persists a local workspace path as added (unresolved while the folder does not exist yet) while its bundled engine serves and stamps sessions with the realpath; only the desktop reproduces that pairing.",
  },
});

const archivedToast = { text: "Session archived" };
const archiveFailedToast = { text: "Couldn't archive session" };

test("archiving a split-pane session works when the desktop stores the workspace by a linked path", async ({ world, user, agent, probe, step, evidence }) => {
  const candidate = world.candidate.sessionId;
  const sibling = world.neighbor.sessionId;
  const route = (sessionId: string | null) => `#/workspace/${world.workspace.workspaceId}/session${sessionId ? `/${sessionId}` : ""}`;
  const openConversation = async (sessionId: string) => {
    await agent.run("session.open", { sessionId });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "conversation route opens", until: (hash) => hash === route(sessionId) });
    await user.see("composer", { editable: true });
  };

  await step("the desktop addresses the workspace by its linked path while the engine stamps sessions with the real path", async () => {
    expect(await world.storedWorkspacePath()).toBe(world.workspacePath);
    const directories = await world.engineDirectories();
    expect(directories[candidate]).toBe(world.realWorkspacePath);
    expect(directories[sibling]).toBe(world.realWorkspacePath);
    expect(directories[candidate]).not.toBe(world.workspacePath);
    const stamps = await world.archivedAt();
    expect(stamps[candidate]).toBe(0);
    expect(stamps[sibling]).toBe(0);
    evidence.recordAssertionEvidence(
      "The desktop and the engine spell the same workspace differently",
      `The persisted workspace path was the linked path ${world.workspacePath}; the engine stamped both seeded sessions with ${world.realWorkspacePath}, which differs from it. Neither session was archived.`,
      true,
    );
  });

  let sideChat = "";
  await step("a side chat opened beside the conversation is a new session the engine stamps the same way", async () => {
    await openConversation(candidate);
    const before = Object.keys(await world.archivedAt());
    // The selected conversation's row offers its side chat directly.
    await user.click({ role: "button", label: "Open side chat" });
    const split = await probe.eventually(() => world.splitFacts(), {
      within: 30_000, label: "the conversation owns a new side chat",
      until: (value) => value.primarySessionId === candidate && value.secondaryPaneCount === 1
        && Boolean(value.secondarySessionId) && !before.includes(value.secondarySessionId),
    });
    sideChat = split.secondarySessionId;
    const directories = await probe.eventually(() => world.engineDirectories(), {
      within: 30_000, label: "the side chat is stamped with the engine's real path", until: (value) => value[sideChat] === world.realWorkspacePath,
    });
    expect(directories[sideChat]).toBe(world.realWorkspacePath);
    expect((await world.archivedAt())[sideChat]).toBe(0);
  });

  await step("archiving the side chat succeeds and leaves the conversation and its neighbor open", async () => {
    expect(await agent.run("session.archive", { sessionId: sideChat, archived: true })).toEqual({ ok: true, sessionId: sideChat, archived: true });
    await user.see(archivedToast, { timeoutMs: 30_000 });
    await user.notSee(archiveFailedToast);
    await user.notSee({ text: "Could not verify the conversation's workspace." });
    const stamps = await probe.eventually(() => world.archivedAt(), {
      within: 30_000, label: "only the side chat is archived on the engine", until: (value) => value[sideChat] > 0,
    });
    expect(stamps[sideChat]).toBeGreaterThan(0);
    expect(stamps[candidate]).toBe(0);
    expect(stamps[sibling]).toBe(0);
    await probe.eventually(() => world.splitFacts(), {
      within: 30_000, label: "the conversation stays open alone", until: (value) => value.primarySessionId === candidate && value.secondaryPaneCount === 0,
    });
    expect(await probe.hash()).toBe(route(candidate));
    expect(await world.mutationRequests()).toEqual([expect.objectContaining({ method: "PATCH", path: expect.stringContaining(`/session/${sideChat}`) })]);
    evidence.recordAssertionEvidence(
      "A split-pane session in a linked-path workspace archives instead of failing verification",
      `session.archive on the side chat ${sideChat} showed "Session archived" and never "Couldn't archive session" or "Could not verify the conversation's workspace."; the engine stamped only that session archived, the conversation and its neighbor stayed at 0, the secondary pane closed while the conversation route stayed selected, and exactly one PATCH targeted that session.`,
      true,
    );
  });

  await step("archiving the conversation from the sidebar succeeds, keeps its neighbor, and Undo restores it", async () => {
    const row = { testId: `sidebar-session-${candidate}` };
    await user.hover(row);
    await user.click({ role: "button", label: "Archive session", testId: `session-archive-${candidate}` });
    await user.see(archivedToast, { timeoutMs: 30_000 });
    await user.notSee(archiveFailedToast);
    await user.notSee({ text: "This session is still working" });
    const stamps = await probe.eventually(() => world.archivedAt(), {
      within: 30_000, label: "the conversation is archived on the engine", until: (value) => value[candidate] > 0,
    });
    expect(stamps[candidate]).toBeGreaterThan(0);
    expect(stamps[sibling]).toBe(0);
    const sidebar = await probe.eventually(() => world.sidebar(), {
      within: 30_000, label: "the conversation leaves the tree and its neighbor stays",
      until: (value) => !value.active.includes(candidate) && value.active.includes(sibling) && value.archivedSection,
    });
    expect(sidebar.active).toContain(sibling);
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "archive returns to the workspace start", until: (hash) => hash === route(null) });
    await probe.eventually(() => world.undoToastSettled(), { within: 10_000, label: "undo pill settles", until: Boolean });
    await user.click({ role: "button", label: "Undo" });
    const restored = await probe.eventually(() => world.archivedAt(), {
      within: 30_000, label: "Undo restores the conversation", until: (value) => value[candidate] === 0,
    });
    expect(restored[sibling]).toBe(0);
    expect(restored[sideChat]).toBeGreaterThan(0);
    await probe.eventually(() => probe.hash(), { within: 15_000, label: "Undo reopens the conversation", until: (hash) => hash === route(candidate) });
    evidence.recordAssertionEvidence(
      "The sidebar Archive button works in a linked-path workspace and Undo restores only its target",
      `Hovering the conversation row and clicking Archive showed "Session archived" without the failure toast or a working-session prompt; the engine stamped the conversation archived while its neighbor stayed at 0, the sidebar moved only the conversation into Archived, the route returned to the workspace start, and Undo restored the conversation (neighbor still 0, the earlier side chat still archived) and reopened it.`,
      true,
    );
  });
});
