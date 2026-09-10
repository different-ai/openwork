import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import type { Seed } from "@openwork/env";
import { existingSessionDraft } from "../worlds/session-draft.ts";

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

const existingDraftTest = spec.world(existingSessionDraft, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

existingDraftTest("an existing conversation keeps its title and an accessible draft marker through navigation and reload", async ({ user, probe, step, world }) => {
  const draft = "Check the release notes\nKeep the rollback instructions too.";
  const newDraft = "Plan a separate task";
  const existing = { testId: `sidebar-session-${world.session.sessionId}` };
  const neighbor = { testId: `sidebar-session-${world.neighbor.sessionId}` };
  const reference = { testId: `sidebar-session-${world.reference.sessionId}` };
  const draftRow = { testId: `sidebar-new-task-draft-${world.workspace.workspaceId}` };
  const marked = { ...existing, role: "button" as const, label: /Release checklist, .*Draft$/ };
  const rowSelector = `[data-testid="${existing.testId}"]`;
  const marker = { testId: `sidebar-session-draft-${world.session.sessionId}` };
  const seeRestoredDraft = async () => {
    await user.see("composer", { editable: true, text: /Check the release notes\s+Keep the rollback instructions too\./ });
    // innerText inserts two newlines between paragraphs; the composer serializes one.
    const paragraphs = await probe.dom('[data-lexical-editor="true"] > p');
    expect(paragraphs.elements.map((paragraph) => paragraph.text).join("\n")).toBe(draft);
  };
  const draftKeys = () => probe.storage("openwork.session-drafts.v2", (value) => {
    if (typeof value !== "object" || value === null || !("drafts" in value) || typeof value.drafts !== "object" || value.drafts === null) return [];
    return Object.keys(value.drafts);
  });

  await step("establish prior conversation history", async () => {
    await user.type("composer", world.history.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.history.reply });
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(marker);
  });

  await step("an unsent follow-up marks only its existing conversation without replacing its title", async () => {
    await user.type("composer", draft, { verify: true });
    await user.click(neighbor);
    await user.see("composer", { editable: true, text: "" });
    await user.see(marked);
    await user.see(marker, { text: "Draft" });
    expect((await probe.dom(rowSelector)).elements).toHaveLength(1);
    expect((await probe.dom(`${rowSelector} [data-session-title-slot]`)).elements[0]?.text).toBe(world.session.title);
    expect((await probe.dom(rowSelector)).elements[0]?.text).not.toContain(draft);
    await user.notSee({ ...neighbor, label: /Draft/ });
    await user.notSee(draftRow);
  });

  await step("new-task drafts remain independent and both are discoverable after reloading elsewhere", async () => {
    await user.click(newSession);
    await user.type("composer", newDraft, { verify: true });
    await user.see(draftRow, { text: `Draft: ${newDraft}` });
    await user.click(neighbor);
    await user.reload();
    await user.see("composer", { editable: true, text: "" });
    await user.see(reference);
    await user.notSee({ ...reference, label: /Draft/ });
    await user.see(marked);
    await user.see(marker, { text: "Draft" });
    await user.see(draftRow, { text: `Draft: ${newDraft}` });
    expect(await draftKeys()).toHaveLength(2);
    await user.click(existing);
    await seeRestoredDraft();
    await user.see({ text: world.history.reply });
    await user.screenshot();
  });

  await step("whitespace and clearing remove the marker but keep the conversation and the other draft", async () => {
    await user.type("composer", " ", { replace: true });
    await user.notSee(marker);
    await user.notSee(marked);
    await user.press("Backspace");
    await user.see("composer", { editable: true, text: "" });
    await user.see(existing);
    await user.see(draftRow, { text: `Draft: ${newDraft}` });
    expect(await draftKeys()).toHaveLength(1);
  });

  await step("sending clears the draft while a subsequent draft coexists with activity", async () => {
    await user.type("composer", world.followup.prompt, { verify: true });
    await user.see(marker, { text: "Draft" });
    await user.press("Enter");
    await user.see({ text: world.followup.reply });
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(marker);
    expect(await draftKeys()).toHaveLength(1);
    await user.type("composer", draft, { verify: true });
    await user.click(neighbor);
    await user.see({ ...existing, label: /Release checklist, Responding, Draft$/ });
    await user.see(marker, { text: "Draft" });
    expect((await probe.dom(`${rowSelector} [role="status"]`)).elements).toHaveLength(1);
    await world.releaseReply();
    await user.see({ ...existing, label: /Release checklist, Unread result, Draft$/ });
    await user.click(existing);
    await seeRestoredDraft();
    await user.type("composer", " ", { replace: true });
    await user.press("Backspace");
    await user.click(draftRow);
    await user.see("composer", { editable: true, text: newDraft });
    await user.notSee(marker);
  });
});
