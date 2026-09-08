import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { taskActivity } from "../worlds/chat.ts";

const test = spec.world(taskActivity);

test("delegated-task activity stays with its original message after a follow-up", async ({ user, probe }) => {
  await user.see({ text: "Build isolated Azure repro" });
  await user.see({ text: "What is the update?" });
  // TODO(primitive): inspect the visual treatment classes on a delegated-task status row.
  const rendered = await probe.eval(() => {
    const row = document.querySelector<HTMLElement>('[data-subagent-activity="shimmer"]');
    const original = document.querySelector<HTMLElement>('[data-message-id$=":eval-subagent-assistant"]');
    const followup = document.querySelector<HTMLElement>('[data-message-id$=":eval-subagent-followup"]');
    return {
      text: row instanceof HTMLElement ? row.innerText.replace(/\s+/g, " ").trim() : "",
      hasSpinner: Boolean(row?.querySelector<HTMLElement>(".animate-spin")),
      hasShimmer: Boolean(row?.querySelector<HTMLElement>(".ow-text-shimmer")),
      liveCards: document.querySelectorAll('[data-subagent-run="eval-subagent-activity"]').length,
      historyEntries: document.querySelectorAll('[data-subagent-history="eval-subagent-activity"]').length,
      carriedSummaries: document.querySelectorAll('[data-testid="active-subagents"]').length,
      staysWithOriginalMessage: Boolean(row && original?.contains(row)),
      precedesFollowup: Boolean(row && followup && (row.compareDocumentPosition(followup) & Node.DOCUMENT_POSITION_FOLLOWING)),
      rawPromptVisible: document.body.innerText.includes("Reproduce the Azure failure in isolation."),
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
  });
});
