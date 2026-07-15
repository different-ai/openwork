import { describe, expect, test } from "bun:test";

import { resolveOrganizationPromptCardContent } from "../src/components/chat/task-suggestions";

describe("organization task suggestions", () => {
  test("uses the saved description as the card title and selects the full prompt", () => {
    const prompt = "Analyze the latest churn feedback and summarize the top three risks.";

    expect(resolveOrganizationPromptCardContent({
      prompt,
      description: "Review churn feedback",
      index: 0,
    })).toEqual({
      title: "Review churn feedback",
      description: prompt,
      selectionPrompt: prompt,
    });
  });

  test("keeps a prompt-only fallback title for older policy data", () => {
    expect(resolveOrganizationPromptCardContent({
      prompt: "Draft a customer update.",
      index: 1,
    }).title).toBe("Organization prompt 2");
  });
});
