import { expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { smallModelRef } from "../src/app/lib/opencode-v2-adapter";
import {
  followUpExchange,
  followUpPrompt,
  parseFollowUpSuggestion,
} from "../src/react-app/domains/session/surface/composer/follow-up-suggestion";

function message(id: string, role: "user" | "assistant", text: string): UIMessage {
  return { id, role, parts: text ? [{ type: "text", text }] : [] };
}

function model(id: string, extra: Record<string, unknown> = {}) {
  return {
    id, providerID: "anthropic", status: "active", variants: [],
    capabilities: { input: ["text"], output: ["text"] }, ...extra,
  };
}

test("a suggestion is one short sendable line", () => {
  expect(parseFollowUpSuggestion("Run the tests again")).toBe("Run the tests again");
  expect(parseFollowUpSuggestion('  "Open the pull request"\n')).toBe("Open the pull request");
});

test("no suggestion when the model declines or answers with anything else", () => {
  for (const answer of ["NONE", "none.", '"None"', "", "   ", "Do this\nThen that", "<user>Deploy it</user>", "a".repeat(121)]) {
    expect(parseFollowUpSuggestion(answer)).toBeNull();
  }
  // A suggestion that merely starts with the word is kept.
  expect(parseFollowUpSuggestion("None of these fit, show more")).toBe("None of these fit, show more");
});

test("only a finished reply with text is asked about", () => {
  const request = message("m1", "user", "Fix the login bug");
  const reply = message("m2", "assistant", "Fixed. Want me to add a test?");
  expect(followUpExchange([request, reply])).toEqual({ replyId: "m2", request: "Fix the login bug", reply: "Fixed. Want me to add a test?" });
  expect(followUpExchange([request, reply, message("m3", "user", "Yes")])).toBeNull();
  expect(followUpExchange([request, message("m2", "assistant", "")])).toBeNull();
  expect(followUpExchange([reply])).toBeNull();
  expect(followUpExchange([])).toBeNull();
});

test("the prompt keeps the start of the request and the end of the reply", () => {
  const prompt = followUpPrompt({ request: `start${"x".repeat(3_000)}`, reply: `${"y".repeat(6_000)}end` });
  expect(prompt).toContain("<user>\nstart");
  expect(prompt).toContain("end\n</assistant>");
  expect(prompt.length).toBeLessThan(6_500);
  expect(prompt).toContain("Answer NONE");
});

test("the provider's small model is used, in the engine's order, at its lowest effort", () => {
  const models = [
    model("claude-opus", { family: "claude-opus" }),
    model("claude-haiku", { family: "claude-haiku", variants: [{ id: "high" }, { id: "low" }] }),
    model("gemini-flash", { family: "gemini-flash", providerID: "google" }),
  ];
  expect(smallModelRef(models, { providerID: "anthropic", modelID: "claude-opus" }))
    .toEqual({ providerID: "anthropic", id: "claude-haiku", variant: "low" });
});

test("a provider with no usable small model writes the suggestion with the chat's own model", () => {
  const models = [
    model("claude-opus", { family: "claude-opus", variants: [{ id: "minimal" }, { id: "high" }] }),
    model("claude-haiku", { family: "claude-haiku", status: "deprecated" }),
    model("claude-haiku-image", { family: "claude-haiku", capabilities: { input: ["text"], output: ["image"] } }),
  ];
  expect(smallModelRef(models, { providerID: "anthropic", modelID: "claude-opus" }))
    .toEqual({ providerID: "anthropic", id: "claude-opus", variant: "minimal" });
  expect(smallModelRef([], { providerID: "openwork-auto", modelID: "auto" })).toEqual({ providerID: "openwork-auto", id: "auto" });
});
