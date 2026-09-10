import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { emptyWorkspaceInventory } from "../worlds/workspace-inventory.ts";

const test = spec.world(async seed => {
  const workspacePath = seed.tmpPath("workspace-inventory");
  const app = await seed.appWeb({ name: "workspace-inventory", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const sessions = await seed.sessions(app, Array.from({ length: 21 }, (_, index) => `Inventory conversation ${index + 1}`));
  return { app, workspace, sessions };
}, {
  resources: { surfaces: ["appWeb"], services: [] },
});

// Archive/Undo count transitions use session-archive-undo's real desktop engine.
test("workspace inventory counts survive previews, pins, groups, drafts and reload", async ({ world, user, agent, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;
  const count = { testId: `workspace-conversation-count-${workspaceId}` };
  const session = world.sessions.at(-1);
  if (!session) throw new Error("Missing inventory fixture session");
  await step("the full inventory is named accessibly before Show more", async () => {
    await user.see(count, { text: "21", timeoutMs: 90_000 });
    expect((await probe.dom('[data-sidebar-workspace-title][aria-description="21 unarchived top-level conversations, including pinned conversations"]')).elements).toHaveLength(1);
    await user.click({ text: "Show 6 more" });
    await user.see(count, { text: "21" });
    await user.click({ role: "button", label: "Collapse", nth: 0 });
    await user.see(count, { text: "21" });
    await user.notSee({ testId: `sidebar-session-${session.sessionId}` });
    await user.click({ role: "button", label: "Expand", nth: 0 });
    await user.see(count, { text: "21" });
  });
  await step("pinning and grouping do not remove conversations from their owning workspace", async () => {
    expect(await agent.run("session.pin", { sessionId: session.sessionId })).toMatchObject({ ok: true, pinned: true });
    await user.see({ text: "Pinned" });
    await user.see(count, { text: "21" });
    const group = await agent.run("session.group.create", { workspaceId, label: "Inventory review" });
    if (typeof group !== "object" || group === null || !("groupId" in group) || typeof group.groupId !== "string") throw new Error("Group creation returned no ID");
    expect(await agent.run("session.group.move", { workspaceId, sessionId: session.sessionId, groupId: group.groupId })).toMatchObject({ ok: true });
    await user.see({ text: "Inventory review" });
    await user.see(count, { text: "21" });
    expect(await agent.run("session.pin", { sessionId: session.sessionId })).toMatchObject({ ok: true, pinned: false });
    await user.notSee({ text: "Pinned" });
    await user.see({ testId: `sidebar-session-${session.sessionId}` });
    await user.see(count, { text: "21" });
  });
  await step("a real unsent draft adds no conversation", async () => {
    await user.click({ role: "button", label: "New session" });
    await user.see("composer", { editable: true });
    await user.type("composer", "Unsent inventory note");
    await user.see({ testId: `sidebar-new-task-draft-${workspaceId}` });
    await user.see(count, { text: "21" });
  });
  await step("a cold renderer reload retains the inventory and count explanation", async () => {
    await user.reload();
    await user.see(count, { text: "21", timeoutMs: 90_000 });
    await user.notSee({ text: "Pinned" });
    await user.see({ text: "Inventory review" });
  });
});

const emptyTest = spec.world(emptyWorkspaceInventory, { resources: { surfaces: ["appWeb"], services: [] } });

emptyTest("confirmed empty workspace shows zero but pending and failed inventory never do", async ({ world, user, agent, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;
  const count = { testId: `workspace-conversation-count-${workspaceId}` };
  await step("a completed empty inventory has an accessible zero", async () => {
    await user.see(count, { text: "0", timeoutMs: 90_000 });
    expect((await probe.dom('[data-sidebar-workspace-title][aria-description="0 unarchived top-level conversations, including pinned conversations"]')).elements).toHaveLength(1);
  });
  await step("a held read and its rejection hide zero until a successful reload", async () => {
    await world.setFault("hold");
    const pending = agent.run("workspace.reload_sessions", { workspaceId });
    await probe.eventually(() => world.held(), { within: 15_000, label: "inventory request held at HTTP boundary" });
    await user.notSee(count);
    await world.setFault("fail");
    await pending;
    await user.notSee(count);
    expect((await probe.dom('[data-sidebar-workspace-title][aria-description]')).elements).toHaveLength(0);
    await world.setFault("normal");
    await agent.run("workspace.reload_sessions", { workspaceId });
    await user.see(count, { text: "0" });
  });
});
