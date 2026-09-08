import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamStates } from "./bridge";
import { parseReferralBrief, referralPrompt } from "./conversation.ts";
import {
  resolveTeamCards,
  teamCardsFromCalls,
} from "./team.ts";

function kept(structured: Record<string, unknown>, text = "ok"): Record<string, unknown> {
  return { openworkMcpResult: { content: [{ type: "text", text }], structuredContent: structured } };
}

const SUGGESTION = {
  id: "sug_1",
  by: "nova",
  name: "Care",
  role: "Customer support",
  roleId: "support",
  mission: "I watch the inbox.",
  why: "the support inbox comes up every morning",
  avatarColor: "rose",
  avatarGlasses: "none",
  personality: "warm",
};

const REFERRAL = {
  id: "ref_1",
  to: { slug: "editor", name: "Editor", role: "Writing and content", mission: "I write.", avatarColor: "violet", avatarGlasses: "square" },
  message: "Draft the launch announcement",
  why: "Editor writes for a living.",
};

test("tiles come only from kept tool results: a suggestion, a hand-over, never a guard outcome or prose", () => {
  const cards = teamCardsFromCalls([
    { tool: "coworker_team_refer", status: "completed", output: null, metadata: kept({ kept: { at: 1 } }) },
    { tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ suggestion: SUGGESTION }) },
    { tool: "coworker_team_refer", status: "completed", output: null, metadata: kept({ referral: REFERRAL }) },
    { tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ existing: { slug: "editor", name: "Editor" } }) },
    { tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ declined: { at: 1 } }) },
    { tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ limit: "daily" }) },
    { tool: "coworker_team_list", status: "completed", output: null, metadata: kept({ team: [] }) },
    { tool: "coworker_team_suggest", status: "error", output: null, metadata: kept({ suggestion: { ...SUGGESTION, id: "sug_failed" } }) },
    { tool: "coworker_team_suggest", status: "completed", output: "Suggested Care for customer support.", metadata: {} },
    { tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ suggestion: SUGGESTION }) },
  ]);
  assert.equal(cards.length, 2, "one suggestion, one hand-over; duplicates and guard outcomes carry no tile");
  const [suggestion, referral] = cards;
  assert.ok(suggestion?.kind === "suggestion");
  assert.equal(suggestion.name, "Care");
  assert.equal(suggestion.state, "open");
  assert.ok(referral?.kind === "referral");
  assert.equal(referral.to.name, "Editor");
  assert.equal(referral.message, "Draft the launch announcement");
  assert.equal(referral.state, "open");
});

test("the person's recorded answer settles a tile; without one a later message closes the pills", () => {
  const cards = teamCardsFromCalls([
    { tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ suggestion: SUGGESTION }) },
    { tool: "coworker_team_refer", status: "completed", output: null, metadata: kept({ referral: REFERRAL }) },
  ]);
  const states: TeamStates = {
    suggestions: [{ id: "sug_1", state: "accepted", at: 2, createdSlug: "care" }],
    referrals: [{ id: "ref_1", state: "asked", at: 3 }],
  };
  const settled = resolveTeamCards(cards, states, false);
  assert.equal(settled[0]?.state, "added");
  assert.equal(settled[0]?.kind === "suggestion" ? settled[0].createdSlug : "", "care");
  assert.equal(settled[1]?.state, "asked");
  const declined = resolveTeamCards(cards, { suggestions: [{ id: "sug_1", state: "declined", at: 2, createdSlug: "" }], referrals: [{ id: "ref_1", state: "continued", at: 3 }] }, false);
  assert.deepEqual(declined.map((card) => card.state), ["declined", "continued"]);
  assert.deepEqual(resolveTeamCards(cards, null, false).map((card) => card.state), ["open", "open"]);
  assert.deepEqual(resolveTeamCards(cards, { suggestions: [], referrals: [] }, true).map((card) => card.state), ["declined", "continued"]);
  // A recorded answer wins over the transcript.
  assert.equal(resolveTeamCards(cards, states, true)[0]?.state, "added");
});

test("a hand-over carries the person's words and a bounded brief, and reads back as the person's message", () => {
  const recent = [
    { role: "user", text: "Hi Nova" },
    { role: "assistant", text: "Hi! What are we working on?" },
    { role: "user", text: "We launch next week." },
    { role: "assistant", text: "Got it. " + "x".repeat(700) },
    { role: "user", text: "Draft the launch announcement" },
  ];
  const prompt = referralPrompt({ from: { name: "Nova", role: "Research and synthesis" }, message: "Draft the launch announcement", why: "Editor writes for a living.", recent });
  assert.ok(prompt.startsWith("Draft the launch announcement\n\nPassed from Nova (Research and synthesis): Editor writes for a living.\n"));
  assert.match(prompt, /\nRecent context:\n/);
  assert.match(prompt, /\nYou: We launch next week\.\n/);
  const contextBlock = prompt.slice(prompt.indexOf("Recent context:"), prompt.indexOf("Take it from here"));
  assert.ok(contextBlock.length <= 600 + "Recent context:\n".length + 20, `context is bounded: ${contextBlock.length}`);
  assert.doesNotMatch(prompt, /Draft the launch announcement[\s\S]*Draft the launch announcement/, "the request is not repeated as context");

  const brief = parseReferralBrief(prompt);
  assert.ok(brief);
  assert.equal(brief.message, "Draft the launch announcement");
  assert.equal(brief.from, "Nova");
  assert.equal(brief.fromRole, "Research and synthesis");
  assert.equal(brief.why, "Editor writes for a living");
  assert.equal(brief.context[0]?.speaker, "you");
  assert.ok(brief.context.length >= 1 && brief.context.length <= 6);

  assert.equal(parseReferralBrief("Just a normal message"), null);
  assert.equal(parseReferralBrief("Passed from Nova.\n\nTake it from here as your own request; the person is now talking to you."), null, "a brief with no request is not one");
});
