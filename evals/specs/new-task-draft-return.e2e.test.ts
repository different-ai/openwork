import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Seed } from "@openwork/env";

async function draftReturn(seed: Seed) {
  const workspacePath = seed.tmpPath("new-task-draft-return");
  const app = await seed.appWeb({ name: "new-task-draft-return", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const session = await seed.session(app, { title: "Existing conversation" });
  return { app, workspace, session };
}

const test = spec.world(draftReturn, {
  resources: { surfaces: ["appWeb"], services: [] },
});

// The workspace "+" and the sidebar "New session" button share one handler:
// both open the workspace's empty composer, which creates its session only on
// send. Until then the typed prompt has no conversation to live in.
const newSession = { role: "button" as const, label: "New session" };

test("an unsent new-task prompt survives opening another session and is reachable from the sidebar", async ({ user, probe, step, world }) => {
  const draft = "Ask about the deploy checklist before Friday";
  const existing = { testId: `sidebar-session-${world.session.sessionId}` };
  const draftRow = { testId: `sidebar-new-task-draft-${world.workspace.workspaceId}` };
  const draftKeys = () => probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("drafts" in value) || typeof value.drafts !== "object" || value.drafts === null) return [];
    return Object.keys(value.drafts);
  });

  await step("start a new task and type without sending", async () => {
    await user.click(newSession);
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(draftRow);
    await user.type("composer", draft, { verify: true });
    await user.see(draftRow, { text: `Draft: ${draft}` });
    const keys = await draftKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]).toContain("__new-task__");
    expect(keys[0]).not.toContain(world.session.sessionId);
  });

  await step("open the existing conversation to look something up", async () => {
    await user.click(existing);
    await user.see("composer", { editable: true, text: "" });
    await user.see(draftRow, { text: `Draft: ${draft}` });
  });

  await step("come back to the draft from the sidebar", async () => {
    await user.click(draftRow);
    await user.see("composer", { editable: true, text: draft });
    await user.screenshot();
  });

  await step("the draft also survives a restart of the renderer", async () => {
    await user.reload();
    await user.see(draftRow, { text: `Draft: ${draft}` });
    await user.click(draftRow);
    await user.see("composer", { editable: true, text: draft });
  });

  await step("clearing the prompt removes the draft and its sidebar row", async () => {
    await user.type("composer", " ", { replace: true });
    await user.press("Backspace");
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(draftRow);
    expect(await draftKeys()).toEqual([]);
  });
});
