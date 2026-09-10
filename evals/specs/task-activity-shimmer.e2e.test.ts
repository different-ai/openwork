import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { taskActivityWeb } from "../worlds/task-activity-web.ts";

const test = spec.world(taskActivityWeb, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
});

test("ACT-01 delegated-task activity stays with its original message after a follow-up", async ({ world, user, probe, evidence }) => {
  await user.type("composer", world.prompt);
  await user.click("Run task");
  const native = await probe.eventually(() => world.native(), {
    within: 90_000, intervalMs: 100, label: "native delegation has a running child association",
    until: (value) => Boolean(value?.childId),
  });
  if (!native?.childId) throw new Error("Missing native child association");
  expect(native.status, JSON.stringify(native)).toBe("running");
  evidence.recordJsonArtifact("Native delegation identity", native);
  await user.type("composer", "What is the update?", { verify: true });
  // Busy Enter queues; the production Cmd/Ctrl+Enter shortcut sends steering now.
  await user.press(world.app.handle.hostKind !== "daytona" && process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  await user.see({ text: "Build isolated Azure repro" });
  await user.see({ text: "What is the update?" });
  // TODO(primitive): inspect the visual treatment classes on a delegated-task status row.
  const readActivity = () => probe.eval(() => {
    const row = document.querySelector<HTMLElement>('[data-subagent-activity="shimmer"]');
    const original = row?.closest<HTMLElement>('[data-message-id]');
    const followup = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((message) => message.innerText.includes("What is the update?"));
    const button = row?.querySelector<HTMLButtonElement>(":scope > button.group");
    const title = button?.querySelector<HTMLElement>(".ow-text-shimmer");
    const suffix = title?.querySelector<HTMLElement>(":scope > span");
    const status = button?.querySelector<HTMLElement>(":scope > span:nth-child(2)");
    if (!row || !button || !title || !suffix || !status) {
      throw new Error("Missing running task title, agent label, or status");
    }
    const style = getComputedStyle(title);
    return {
      text: row instanceof HTMLElement ? row.innerText.replace(/\s+/g, " ").trim() : "",
      hasSpinner: Boolean(row?.querySelector<HTMLElement>(".animate-spin")),
      hasShimmer: Boolean(row?.querySelector<HTMLElement>(".ow-text-shimmer")),
      liveCards: document.querySelectorAll('[data-subagent-run]').length,
      historyEntries: document.querySelectorAll('[data-subagent-history]').length,
      messageId: original?.getAttribute("data-message-id"),
      carriedSummaries: document.querySelectorAll('[data-testid="active-subagents"]').length,
      staysWithOriginalMessage: Boolean(row && original?.contains(row)),
      precedesFollowup: Boolean(row && followup && (row.compareDocumentPosition(followup) & Node.DOCUMENT_POSITION_FOLLOWING)),
      rawPromptVisible: document.body.innerText.includes("ACTIVITY_CHILD_HOLD"),
      childId: row.getAttribute("data-subagent-session-id"),
      callId: row.getAttribute("data-subagent-run"),
      hovered: button.matches(":hover"),
      colorSettled: button.getAnimations().every((animation) => animation.playState !== "running"),
      buttonColor: getComputedStyle(button).color,
      titleStyle: { color: style.color, backgroundImage: style.backgroundImage, animationName: style.animationName },
      mutedColors: [getComputedStyle(suffix).color, getComputedStyle(status).color],
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
    };
  });
  await user.hover("composer");
  const rendered = await probe.eventually(readActivity, {
    within: 5_000, intervalMs: 50, label: "running task is not hovered",
    until: (value) => !value.hovered && value.colorSettled,
  });
  evidence.recordJsonArtifact("Delegated activity state", rendered);
  expect(rendered).toMatchObject({
    text: expect.stringMatching(/Build isolated Azure repro.*Working/),
    hasSpinner: false,
    hasShimmer: true,
    liveCards: 1,
    historyEntries: 0,
    carriedSummaries: 0,
    staysWithOriginalMessage: true,
    precedesFollowup: true,
    rawPromptVisible: false,
    messageId: native.messageId,
  });
  expect(rendered.childId).toBe(native.childId);
  expect(rendered.callId).toBe(native.callId);
  expect(rendered.titleStyle.animationName).toBe(rendered.reducedMotion ? "none" : "ow-text-shimmer");
  if (!rendered.reducedMotion) expect(rendered.titleStyle.backgroundImage).toContain("linear-gradient");

  await user.hover({ role: "button", label: /Build isolated Azure repro/ });
  const hovered = await probe.eventually(readActivity, {
    within: 5_000, intervalMs: 50, label: "hovered task title uses solid foreground",
    until: (value) => value.hovered && value.colorSettled
      && value.titleStyle.backgroundImage === "none" && value.titleStyle.animationName === "none"
      && value.titleStyle.color === value.buttonColor,
  });
  expect(hovered.titleStyle.color).not.toBe(rendered.buttonColor);
  expect(hovered.mutedColors).toEqual(rendered.mutedColors);
  expect(hovered.text).toMatch(/Working/);

  await user.hover("composer");
  const restored = await probe.eventually(readActivity, {
    within: 5_000, intervalMs: 50, label: "task shimmer returns after pointer leave",
    until: (value) => !value.hovered && value.colorSettled
      && value.titleStyle.backgroundImage === rendered.titleStyle.backgroundImage
      && value.titleStyle.animationName === rendered.titleStyle.animationName,
  });
  expect(restored.titleStyle).toEqual(rendered.titleStyle);
  expect(restored.mutedColors).toEqual(rendered.mutedColors);
  evidence.recordJsonArtifact("Delegated task hover", { rendered, hovered, restored });
  evidence.recordAssertionEvidence("Running task titles use the normal hover foreground",
    "Hover replaces the title shimmer with solid inherited text; pointer leave restores its running treatment without recoloring the agent label or status.", true);
  await user.click({ role: "button", label: /Build isolated Azure repro/ });
  await user.see({ text: /ACTIVITY_CHILD_HOLD/ });
  await user.see({ text: /Working/ });
  await user.reload();
  await user.see({ text: /ACTIVITY_CHILD_HOLD/ }, { timeoutMs: 30_000 });
  await user.see({ text: /Working/ });
  expect((await probe.dom(`[data-session-surface-id="${native.childId}"]`)).elements).toHaveLength(1);
  expect((await world.replyState()).deliveredChunks).toBe(1);
  await user.notSee({ text: "Activity child finished." });
  evidence.recordAssertionEvidence("Delegated activity opens the exact live child across reload",
    "Original row shimmers before follow-up; opening it and reloading preserves the child session, prompt and Working state while the provider remains held.", true);
});
