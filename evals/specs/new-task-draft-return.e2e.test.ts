import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { currentTestEvidence } from "@openwork/test-evidence";
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

function assertObserved(assertion: string, observed: Record<string, unknown>, passed: boolean) {
  currentTestEvidence()?.recordAssertionEvidence(assertion, JSON.stringify(observed), passed);
  expect(passed, assertion).toBe(true);
}

test("an unsent new-task prompt survives navigation without a sidebar draft row", async ({ user, probe, step, world }) => {
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
    await user.notSee(draftRow);
    const keys = await draftKeys();
    assertObserved("The new-task draft belongs only to its reserved slot, not the existing conversation",
      { keys, excludedSessionId: world.session.sessionId },
      keys.length === 1 && keys[0]!.includes("__new-task__") && !keys[0]!.includes(world.session.sessionId));
  });

  await step("open the existing conversation to look something up", async () => {
    await user.click(existing);
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(draftRow);
    const otherComposer = (await probe.composer()).draftText;
    const rows = (await probe.dom(`[data-testid="${draftRow.testId}"]`)).elements;
    assertObserved("Opening another conversation shows no draft row and does not leak its text into that composer",
      { otherComposer, rows }, otherComposer.trim() === "" && rows.length === 0);
  });

  await step("come back to the draft with New session", async () => {
    await user.click(newSession);
    await user.see("composer", { editable: true, text: draft });
    const recovered = (await probe.composer()).draftText;
    assertObserved("New session restores the exact unsent prompt", { recovered, expected: draft }, recovered === draft);
    await user.screenshot();
  });

  await step("the draft also survives a restart of the renderer", async () => {
    await user.reload();
    await user.notSee(draftRow);
    await user.click(newSession);
    await user.see("composer", { editable: true, text: draft });
    const recovered = (await probe.composer()).draftText;
    const keys = await draftKeys();
    assertObserved("Renderer reload preserves the exact new-task prompt without creating a conversation draft",
      { recovered, expected: draft, keys, excludedSessionId: world.session.sessionId },
      recovered === draft && keys.length === 1 && !keys[0]!.includes(world.session.sessionId));
  });

  await step("clearing the prompt removes the stored draft", async () => {
    await user.type("composer", " ", { replace: true });
    await user.press("Backspace");
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(draftRow);
    const keys = await draftKeys();
    const rows = (await probe.dom(`[data-testid="${draftRow.testId}"]`)).elements;
    const remainingConversation = (await probe.dom(`[data-testid="${existing.testId}"]`)).elements;
    assertObserved("Clearing removes the new-task storage, not the existing conversation, with no draft row",
      { keys, rows, remainingConversation }, keys.length === 0 && rows.length === 0 && remainingConversation.length === 1);
  });
});

const existingDraftTest = spec.world(existingSessionDraft, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

existingDraftTest("an existing conversation restores drafts without sidebar markers through navigation and reload", async ({ user, probe, step, world }) => {
  const draft = "Check the release notes\nKeep the rollback instructions too.";
  const newDraft = "Plan a separate task";
  const existing = { testId: `sidebar-session-${world.session.sessionId}` };
  const neighbor = { testId: `sidebar-session-${world.neighbor.sessionId}` };
  const reference = { testId: `sidebar-session-${world.reference.sessionId}` };
  const draftRow = { testId: `sidebar-new-task-draft-${world.workspace.workspaceId}` };
  const rowSelector = `[data-testid="${existing.testId}"]`;
  const marker = { testId: `sidebar-session-draft-${world.session.sessionId}` };
  const seeRestoredDraft = async () => {
    await user.see("composer", { editable: true, text: /Check the release notes\s+Keep the rollback instructions too\./ });
    // innerText inserts two newlines between paragraphs; the composer serializes one.
    const paragraphs = await probe.dom('[data-lexical-editor="true"] > p');
    const recovered = paragraphs.elements.map((paragraph) => paragraph.text).join("\n");
    assertObserved("Reopening restores the exact multiline follow-up, not the independent new-task draft",
      { recovered, expected: draft, excluded: newDraft }, recovered === draft && recovered !== newDraft);
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

  await step("an unsent follow-up preserves the conversation title without a draft marker", async () => {
    await user.type("composer", draft, { verify: true });
    await user.click(neighbor);
    await user.see("composer", { editable: true, text: "" });
    await user.see(existing);
    await user.notSee(marker);
    const rows = (await probe.dom(rowSelector)).elements;
    const titles = (await probe.dom(`${rowSelector} [data-session-title-slot]`)).elements;
    const accessible = (await probe.dom(`${rowSelector}[aria-label$=", Draft"]`)).elements;
    const unrelatedDrafts = (await probe.dom(`[data-testid="${neighbor.testId}"][aria-label*="Draft"]`)).elements;
    assertObserved("One existing row keeps its title without a draft label, prompt preview or unrelated marker",
      { rows, titles, accessible, unrelatedDrafts, expectedTitle: world.session.title, excludedPreview: draft },
      rows.length === 1 && titles[0]?.text === world.session.title && !rows[0]!.text.includes(draft)
        && accessible.length === 0 && unrelatedDrafts.length === 0);
    await user.notSee({ ...neighbor, label: /Draft/ });
    await user.notSee(draftRow);
  });

  await step("new-task drafts remain independent without indicators after reloading elsewhere", async () => {
    await user.click(newSession);
    await user.see("composer", { editable: true, text: "" });
    await user.type("composer", newDraft, { verify: true });
    await user.notSee(draftRow);
    await user.click(neighbor);
    await user.reload();
    await user.see("composer", { editable: true, text: "" });
    await user.see(reference);
    await user.notSee({ ...reference, label: /Draft/ });
    await user.see(existing);
    await user.notSee(marker);
    await user.notSee(draftRow);
    const keys = await draftKeys();
    const referenceRows = (await probe.dom(`[data-testid="${reference.testId}"]`)).elements;
    const referenceDrafts = (await probe.dom(`[data-testid="${reference.testId}"][aria-label*="Draft"]`)).elements;
    const markers = (await probe.dom(`[data-testid="${marker.testId}"]`)).elements;
    const newTaskRows = (await probe.dom(`[data-testid="${draftRow.testId}"]`)).elements;
    assertObserved("Reload preserves both independent drafts without indicators and retains an unselected conversation",
      { keys, markers, newTaskRows, referenceRows, referenceDrafts, sessionId: world.session.sessionId },
      keys.length === 2 && keys.some((key) => key.includes(world.session.sessionId))
        && keys.some((key) => key.includes("__new-task__")) && markers.length === 0
        && newTaskRows.length === 0 && referenceRows.length === 1 && referenceDrafts.length === 0);
    await user.click(existing);
    await seeRestoredDraft();
    await user.see({ text: world.history.reply });
    await user.screenshot();
  });

  await step("whitespace and clearing keep the conversation and the other draft", async () => {
    await user.type("composer", " ", { replace: true });
    await user.notSee(marker);
    const whitespaceMarkers = (await probe.dom(`[data-testid="${marker.testId}"]`)).elements;
    const whitespaceText = (await probe.composer()).draftText;
    assertObserved("Whitespace does not mark an existing conversation as a draft",
      { whitespaceText, whitespaceMarkers }, whitespaceText.trim() === "" && whitespaceMarkers.length === 0);
    await user.press("Backspace");
    await user.see("composer", { editable: true, text: "" });
    await user.see(existing);
    await user.notSee(draftRow);
    const keys = await draftKeys();
    assertObserved("Clearing the follow-up removes only its persisted draft, retaining the new-task draft",
      { keys, excludedSessionId: world.session.sessionId },
      keys.length === 1 && keys[0]!.includes("__new-task__") && !keys[0]!.includes(world.session.sessionId));
  });

  await step("sending clears the draft while a subsequent draft coexists with activity", async () => {
    await user.type("composer", world.followup.prompt, { verify: true });
    await user.notSee(marker);
    await user.press("Enter");
    await user.see({ text: world.followup.reply });
    await user.see("composer", { editable: true, text: "" });
    await user.notSee(marker);
    const sentKeys = await draftKeys();
    const sentComposer = (await probe.composer()).draftText;
    const sentMarkers = (await probe.dom(`[data-testid="${marker.testId}"]`)).elements;
    assertObserved("Sending clears the follow-up composer and storage without consuming the independent draft or showing a marker",
      { sentKeys, sentComposer, sentMarkers, excludedSessionId: world.session.sessionId },
      sentKeys.length === 1 && sentKeys[0]!.includes("__new-task__") && !sentKeys[0]!.includes(world.session.sessionId)
        && sentComposer.trim() === "" && sentMarkers.length === 0);
    await user.type("composer", draft, { verify: true });
    await user.click(neighbor);
    await user.see({ ...existing, label: /Release checklist, Responding$/ });
    await user.notSee(marker);
    const activity = (await probe.dom(`${rowSelector}[aria-label="Release checklist, Responding"] [role="status"]`)).elements;
    const activeMarkers = (await probe.dom(`[data-testid="${marker.testId}"]`)).elements;
    assertObserved("An unsent follow-up leaves the responding indicator and accessible state unchanged",
      { activity, activeMarkers }, activity.length === 1 && activeMarkers.length === 0);
    await world.releaseReply();
    await user.see({ ...existing, label: /Release checklist, Unread result$/ });
    const unread = (await probe.dom(`${rowSelector}[aria-label="Release checklist, Unread result"] [data-session-attention-indicator]`)).elements;
    const staleActivity = (await probe.dom(`${rowSelector} [role="status"]`)).elements;
    assertObserved("Completion preserves the draft alongside unread state without a stale running indicator",
      { unread, staleActivity }, unread.length === 1 && staleActivity.length === 0);
    await user.click(existing);
    await seeRestoredDraft();
    await user.type("composer", " ", { replace: true });
    await user.press("Backspace");
    await user.click(newSession);
    await user.see("composer", { editable: true, text: newDraft });
    await user.notSee(marker);
  });
});
