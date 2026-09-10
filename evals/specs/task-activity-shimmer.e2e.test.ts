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
  evidence.recordJsonArtifact("Delegated activity state", await probe.eval(() =>
    [...document.querySelectorAll("[data-subagent-run]")].map((row) => ({
      activity: row.getAttribute("data-subagent-activity"), text: row.textContent,
    })),
  ));
  // TODO(primitive): inspect the visual treatment classes on a delegated-task status row.
  const rendered = await probe.eval(() => {
    const row = document.querySelector<HTMLElement>('[data-subagent-activity="shimmer"]');
    const original = row?.closest<HTMLElement>('[data-message-id]');
    const followup = [...document.querySelectorAll<HTMLElement>('[data-message-id]')]
      .find((message) => message.innerText.includes("What is the update?"));
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
    };
  });
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
  expect(await probe.eval(() => document.querySelector('[data-subagent-run]')
    ?.getAttribute("data-subagent-session-id"))).toBe(native.childId);
  expect(await probe.eval(() => document.querySelector('[data-subagent-run]')
    ?.getAttribute("data-subagent-run"))).toBe(native.callId);
  await user.click({ role: "button", label: /Build isolated Azure repro/ });
  await user.see({ text: /ACTIVITY_CHILD_HOLD/ });
  await user.see({ text: /Working/ });
  await probe.eval(() => { location.reload(); });
  await user.see({ text: /ACTIVITY_CHILD_HOLD/ }, { timeoutMs: 30_000 });
  await user.see({ text: /Working/ });
  expect(await probe.eval(() => document.querySelector("[data-session-surface-id]")
    ?.getAttribute("data-session-surface-id"))).toBe(native.childId);
  expect((await world.replyState()).deliveredChunks).toBe(1);
  await user.notSee({ text: "Activity child finished." });
  evidence.recordAssertionEvidence("Delegated activity opens the exact live child across reload",
    "Original row shimmers before follow-up; opening it and reloading preserves the child session, prompt and Working state while the provider remains held.", true);
});
