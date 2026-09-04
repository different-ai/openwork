import assert from "node:assert/strict";
import { test } from "node:test";
import type { TeamStates } from "./bridge";
import { parseReferralBrief, referralPrompt } from "./conversation.ts";
import {
  continueWithReply,
  describeTeamStep,
  newcomerLine,
  referralSmallPrint,
  resolveTeamCards,
  suggestionSmallPrint,
  teamCardsFromCalls,
  teamToolName,
} from "./team.ts";
import { describeWorkStep } from "./work-receipt.ts";

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

test("team tool names are recognised with or without the MCP prefix", () => {
  assert.equal(teamToolName("coworker_team_refer"), "team_refer");
  assert.equal(teamToolName("team_suggest"), "team_suggest");
  assert.equal(teamToolName("Coworker_Team_List"), "team_list");
  assert.equal(teamToolName("coworker_document_create"), null);
  assert.equal(teamToolName("edit"), null);
});

test("a kept request (the person chose to continue) leaves no tile", () => {
  const cards = teamCardsFromCalls([{ tool: "coworker_team_refer", status: "completed", output: null, metadata: kept({ kept: { at: 1 } }) }]);
  assert.deepEqual(cards, []);
});

test("tiles come only from kept tool results: a suggestion, a hand-over, never a guard outcome or prose", () => {
  const cards = teamCardsFromCalls([
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
  assert.equal(suggestion?.kind, "suggestion");
  if (suggestion?.kind !== "suggestion") return;
  assert.equal(suggestion.name, "Care");
  assert.equal(suggestion.role, "Customer support");
  assert.equal(suggestion.avatarColor, "rose");
  assert.equal(suggestion.avatarGlasses, "none");
  assert.equal(suggestion.personality, "warm");
  assert.equal(suggestion.state, "open");
  assert.equal(referral?.kind, "referral");
  if (referral?.kind !== "referral") return;
  assert.equal(referral.to.name, "Editor");
  assert.equal(referral.message, "Draft the launch announcement");
  assert.equal(referral.state, "open");
  // Unknown looks fall back rather than break the tile.
  const odd = teamCardsFromCalls([{ tool: "team_suggest", status: "success", output: null, metadata: kept({ suggestion: { ...SUGGESTION, avatarColor: "plaid", personality: "grumpy" } }) }]);
  assert.equal(odd[0]?.kind === "suggestion" ? odd[0].avatarColor : "", "blue");
  assert.equal(odd[0]?.kind === "suggestion" ? odd[0].personality : "", "neutral");
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

test("small print and the pill that keeps the coworker on it read like Messages", () => {
  const [card] = teamCardsFromCalls([{ tool: "coworker_team_suggest", status: "completed", output: null, metadata: kept({ suggestion: SUGGESTION }) }]);
  if (card?.kind !== "suggestion") throw new Error("expected a suggestion");
  assert.equal(suggestionSmallPrint(card, "Nova"), "Suggested by Nova · Customer support");
  assert.equal(suggestionSmallPrint({ ...card, role: "" }, ""), "Suggested");
  const [referral] = teamCardsFromCalls([{ tool: "coworker_team_refer", status: "completed", output: null, metadata: kept({ referral: REFERRAL }) }]);
  if (referral?.kind !== "referral") throw new Error("expected a referral");
  assert.equal(referralSmallPrint(referral), "Editor could take this · Writing and content");
  assert.equal(continueWithReply("Nova"), "Go ahead, Nova.");
  assert.equal(newcomerLine({ suggestedBy: { slug: "nova", why: "The support inbox comes up every morning." } }, "Nova"), "Nova suggested me — the support inbox comes up every morning.");
  assert.equal(newcomerLine({ suggestedBy: { slug: "nova", why: "" } }, "Nova"), "Nova suggested me.");
  assert.equal(newcomerLine({ suggestedBy: null }, "Nova"), "");
});

test("receipts for the team tools never show ids or slugs, and name the guard outcomes", () => {
  const step = (tool: string, status: string, structured: Record<string, unknown> | null, input: Record<string, unknown> = {}) =>
    describeWorkStep({ tool, status, input, output: null, metadata: structured ? kept(structured) : {} });
  assert.equal(step("coworker_team_list", "completed", { team: [] }).label, "Checked the team");
  assert.equal(step("coworker_team_list", "running", null).label, "Checking the team");
  assert.equal(step("coworker_team_refer", "completed", { referral: REFERRAL }).label, "Offered to pass this to Editor");
  assert.equal(step("coworker_team_refer", "running", null, { to: "editor" }).label, "Offering to pass this on");
  assert.equal(step("coworker_team_refer", "error", null, { to: "Care" }).label, "Couldn't offer to pass this to Care");
  assert.equal(step("coworker_team_refer", "completed", { kept: { at: 1 } }, { to: "editor" }).label, "Checked the team · you asked to keep this here");
  assert.equal(step("coworker_team_suggest", "completed", { suggestion: SUGGESTION }).label, "Suggested a teammate · Care");
  assert.equal(step("coworker_team_suggest", "completed", { existing: { slug: "editor", name: "Editor" } }).label, "Checked the team · Editor already covers this");
  assert.equal(step("coworker_team_suggest", "completed", { existing: { slug: "nova", name: "Nova" }, self: true }).label, "Checked the team · that is its own job");
  assert.equal(step("coworker_team_suggest", "completed", { declined: { at: 1 } }).label, "Checked the team · you said not now to this one");
  assert.equal(step("coworker_team_suggest", "completed", { limit: "daily" }).label, "Checked the team · one suggestion a day");
  assert.equal(step("coworker_team_suggest", "running", null).label, "Thinking about the team");
  assert.equal(step("coworker_team_suggest", "error", null).label, "Couldn't suggest a teammate");
  const described = step("coworker_team_suggest", "completed", { suggestion: SUGGESTION });
  assert.equal(described.service, "your team");
  assert.doesNotMatch(described.label, /sug_|ref_|nova/);
  // describeTeamStep is reachable on its own for the running phrase.
  assert.equal(describeTeamStep("team_suggest", { input: {}, output: null, metadata: {} }, "running").doing, "thinking about the team");
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
  assert.ok(prompt.trimEnd().endsWith("Take it from here as your own request; the person is now talking to you."));
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

  const bare = referralPrompt({ from: { name: "Nova", role: "" }, message: "Plan the offsite", why: "", recent: [] });
  assert.equal(bare, "Plan the offsite\n\nPassed from Nova.\n\nTake it from here as your own request; the person is now talking to you.");
  const parsedBare = parseReferralBrief(bare);
  assert.deepEqual(parsedBare, { message: "Plan the offsite", from: "Nova", fromRole: "", why: "", context: [] });
  assert.equal(parseReferralBrief("Just a normal message"), null);
  assert.equal(parseReferralBrief("Passed from Nova.\n\nTake it from here as your own request; the person is now talking to you."), null, "a brief with no request is not one");
});
