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
  expect(parseFollowUpSuggestion("yes, go ahead")).toBe("yes, go ahead");
  expect(parseFollowUpSuggestion("make it shorter")).toBe("make it shorter");
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
  expect(followUpExchange([request, reply])).toEqual({ replyId: "m2", messages: [
    { role: "user", text: "Fix the login bug" },
    { role: "assistant", text: "Fixed. Want me to add a test?" },
  ] });
  expect(followUpExchange([request, reply, message("m3", "user", "Yes")])).toBeNull();
  expect(followUpExchange([request, message("m2", "assistant", "")])).toBeNull();
  expect(followUpExchange([reply])).toBeNull();
  expect(followUpExchange([])).toBeNull();
});

test("short replies keep the earlier user intent and writing style in context", () => {
  const exchange = followUpExchange([
    message("m1", "user", "just a rough outline, keep it casual"),
    message("m2", "assistant", "Here are two possible outlines."),
    message("m3", "user", "the second one"),
    message("m4", "assistant", "Here is the second outline. I can also build a detailed launch calendar."),
  ]);
  if (!exchange) throw new Error("expected a completed exchange");
  expect(exchange.messages.map((entry) => entry.text)).toEqual([
    "just a rough outline, keep it casual",
    "Here are two possible outlines.",
    "the second one",
    "Here is the second outline. I can also build a detailed launch calendar.",
  ]);
  const prompt = followUpPrompt(exchange);
  expect(prompt).toContain(JSON.stringify(exchange.messages));
  expect(prompt).not.toContain("must move the work forward");
});

test("long messages keep both the result at the start and corrections at the end", () => {
  const exchange = followUpExchange([
    message("m1", "user", `Draft an outline.${"x".repeat(3_000)}Actually, keep it to three bullets.`),
    message("m2", "assistant", `Here are three bullets.${"y".repeat(6_000)}I can expand these.`),
  ]);
  if (!exchange) throw new Error("expected a completed exchange");
  expect(exchange.messages[0].text).toStartWith("Draft an outline.");
  expect(exchange.messages[0].text).toEndWith("Actually, keep it to three bullets.");
  expect(exchange.messages[0].text.length).toBeLessThanOrEqual(1_500);
  expect(exchange.messages[1].text).toStartWith("Here are three bullets.");
  expect(exchange.messages[1].text).toEndWith("I can expand these.");
  expect(exchange.messages[1].text.length).toBeLessThanOrEqual(2_000);
});

test("only recent conversation text is included, with bounded message and character counts", () => {
  const history: UIMessage[] = Array.from({ length: 20 }, (_, index) =>
    message(`m${index}`, index % 2 ? "assistant" : "user", `message ${index}`));
  const exchange = followUpExchange(history);
  if (!exchange) throw new Error("expected a completed exchange");
  expect(exchange.messages).toHaveLength(8);
  expect(exchange.messages[0].text).toBe("message 12");
  expect(exchange.messages.at(-1)?.text).toBe("message 19");

  const longHistory = history.map((entry) => ({ ...entry, parts: [{ type: "text", text: "x".repeat(5_000) }] satisfies UIMessage["parts"] }));
  const longExchange = followUpExchange(longHistory);
  if (!longExchange) throw new Error("expected a completed exchange");
  expect(longExchange.messages.reduce((length, entry) => length + entry.text.length, 0)).toBeLessThanOrEqual(6_000);
  expect(followUpPrompt(longExchange).length).toBeLessThan(8_000);

  const withHiddenParts = followUpExchange([
    { id: "system", role: "system", parts: [{ type: "text", text: "system instructions" }] },
    message("m1", "user", "keep it casual"),
    { id: "reasoning", role: "assistant", parts: [{ type: "reasoning", text: "hidden reasoning" }] },
    { id: "m2", role: "assistant", parts: [
      { type: "dynamic-tool", toolName: "read", toolCallId: "tool1", state: "output-available", input: {}, output: "raw tool output" },
      { type: "text", text: "Here is the outline." },
    ] },
  ]);
  if (!withHiddenParts) throw new Error("expected a completed exchange");
  expect(withHiddenParts.messages).toEqual([
    { role: "user", text: "keep it casual" },
    { role: "assistant", text: "Here is the outline." },
  ]);
});

test("a nearly exhausted context budget never expands a truncated message", () => {
  for (let remaining = 1; remaining <= 6; remaining++) {
    const exchange = followUpExchange([
      message("m1", "assistant", "old reply".repeat(1_000)),
      message("m2", "user", "u".repeat(500)),
      message("m3", "assistant", "a".repeat(2_000)),
      message("m4", "user", "u".repeat(1_500)),
      message("m5", "assistant", "a".repeat(2_000 - remaining)),
    ]);
    if (!exchange) throw new Error("expected a completed exchange");
    expect(exchange.messages[0].text).toHaveLength(remaining);
    expect(exchange.messages.reduce((length, entry) => length + entry.text.length, 0)).toBe(6_000);
  }
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
