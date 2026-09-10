import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sidebarExpansion } from "../worlds/session-shell.ts";

const test = spec.world(seed => sidebarExpansion(seed, "workspace"), {
  resources: { surfaces: ["desktop"], services: [] },
});

test("workspace inventory counts survive previews, pins, groups and drafts, and follow archive and Undo", async ({ world, user, agent, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;
  const count = { testId: `workspace-conversation-count-${workspaceId}` };
  const session = world.sessions[0];
  if (!session) throw new Error("Missing inventory fixture session");
  await step("the full inventory is named accessibly before Show more", async () => {
    await user.see(count, { text: "21", timeoutMs: 90_000 });
    const description = await probe.eval(() => document.querySelector('[data-sidebar-workspace-title]')?.getAttribute("aria-description"));
    expect(description).toBe("21 unarchived top-level conversations, including pinned conversations");
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
    expect(await agent.run("session.group.create", { workspaceId, label: "Inventory review" })).toMatchObject({ ok: true });
    await user.see({ text: "Inventory review" });
    await user.see(count, { text: "21" });
  });
  await step("a real unsent draft adds no conversation", async () => {
    await user.click({ role: "button", label: "New session" });
    await user.see("composer", { editable: true });
    await user.type("composer", "Unsent inventory note");
    await user.see({ testId: `sidebar-new-task-draft-${workspaceId}` });
    await user.see(count, { text: "21" });
  });
  await step("archiving a pinned conversation reduces ownership once and Undo restores it", async () => {
    expect(await agent.run("session.archive", { sessionId: session.sessionId, archived: true })).toMatchObject({ ok: true });
    await user.see(count, { text: "20" });
    await user.see({ text: "Session archived" });
    await user.click({ role: "button", label: "Undo" });
    await user.see(count, { text: "21" });
    await user.see({ testId: `sidebar-session-${session.sessionId}` });
  });
  await step("a cold renderer reload retains the inventory and count explanation", async () => {
    await user.reload();
    await user.see(count, { text: "21", timeoutMs: 90_000 });
    await user.see({ text: "Pinned" });
    await user.see({ text: "Inventory review" });
  });
});
