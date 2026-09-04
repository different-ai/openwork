/**
 * The team in the conversation: what a coworker's team tool calls mean for the
 * person reading the thread. Pure, so the tile a bubble ends with, the state
 * its pills are in, and the receipt line between bubbles are unit-tested and
 * the transcript only renders what these return.
 *
 * A tile only ever comes from a tool result the transcript kept — never from
 * words in the reply — so a model cannot produce one by describing it.
 */
import type { AvatarColor, AvatarGlasses, TeamStates } from "./bridge.ts";
import { TEAM_TOOL_NAMES, type TeamToolName } from "./coworker-tools.ts";
import { keptResult } from "./documents.ts";
import type { Personality } from "./personalities.ts";

/** A teammate as a card shows it: identity and look, never their files. */
export type TeammateIdentity = {
  slug: string;
  name: string;
  role: string;
  mission: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
};

/** A coworker proposed a new teammate; the person adds it or says not now. */
export type SuggestionCard = {
  kind: "suggestion";
  id: string;
  /** Who proposed it. */
  by: string;
  name: string;
  role: string;
  roleId: string;
  mission: string;
  why: string;
  avatarColor: AvatarColor;
  avatarGlasses: AvatarGlasses;
  personality: Personality;
  state: "open" | "added" | "declined";
  /** The coworker the person added from it, once they did. */
  createdSlug: string;
};

/** A coworker offered to pass the request to a teammate; the person asks them or keeps the coworker on it. */
export type ReferralCard = {
  kind: "referral";
  id: string;
  to: TeammateIdentity;
  message: string;
  why: string;
  state: "open" | "asked" | "continued";
};

export type TeamCard = SuggestionCard | ReferralCard;

const AVATAR_COLORS: ReadonlySet<string> = new Set(["blue", "violet", "mint", "orange", "rose", "slate"]);
const AVATAR_GLASSES: ReadonlySet<string> = new Set(["round", "square", "none"]);
const PERSONALITIES: ReadonlySet<string> = new Set([
  "none", "neutral", "warm", "calm", "eager", "playful", "dry", "blunt", "curious", "thoughtful", "meticulous", "detective",
]);

/** `coworker_team_refer` → `team_refer`; anything else → null. */
export function teamToolName(tool: string): TeamToolName | null {
  const lower = tool.toLowerCase();
  for (const name of TEAM_TOOL_NAMES) {
    if (lower === name || lower.endsWith(`_${name}`)) return name;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function color(value: unknown): AvatarColor {
  return typeof value === "string" && AVATAR_COLORS.has(value) ? (value as AvatarColor) : "blue";
}

function glasses(value: unknown): AvatarGlasses {
  return typeof value === "string" && AVATAR_GLASSES.has(value) ? (value as AvatarGlasses) : "round";
}

function personality(value: unknown): Personality {
  return typeof value === "string" && PERSONALITIES.has(value) ? (value as Personality) : "neutral";
}

function identity(value: unknown): TeammateIdentity | null {
  if (!isRecord(value)) return null;
  const slug = text(value.slug);
  const name = text(value.name);
  if (!slug || !name) return null;
  return { slug, name, role: text(value.role), mission: text(value.mission), avatarColor: color(value.avatarColor), avatarGlasses: glasses(value.avatarGlasses) };
}

function isDone(status: string): boolean {
  return status === "completed" || status === "success";
}

/**
 * The tiles a reply ends with, from the team tool calls of that turn that the
 * transcript kept a result for. A guard outcome (a teammate already covers it,
 * a recent decline, the daily limit) has no card: those turns only carry a
 * receipt line. States start `open`; `resolveTeamCards` settles them.
 */
export function teamCardsFromCalls(
  calls: ReadonlyArray<{ tool: string; status: string; output: unknown; metadata: Record<string, unknown> }>,
): TeamCard[] {
  const cards: TeamCard[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    const name = teamToolName(call.tool);
    if (!name || name === "team_list" || !isDone(call.status)) continue;
    const structured = keptResult(call)?.structuredContent;
    if (!structured) continue;
    if (name === "team_suggest" && isRecord(structured.suggestion)) {
      const suggestion = structured.suggestion;
      const id = text(suggestion.id);
      const suggestedName = text(suggestion.name);
      if (!id || !suggestedName || seen.has(id)) continue;
      seen.add(id);
      cards.push({
        kind: "suggestion",
        id,
        by: text(suggestion.by),
        name: suggestedName,
        role: text(suggestion.role),
        roleId: text(suggestion.roleId),
        mission: text(suggestion.mission),
        why: text(suggestion.why),
        avatarColor: color(suggestion.avatarColor),
        avatarGlasses: glasses(suggestion.avatarGlasses),
        personality: personality(suggestion.personality),
        state: "open",
        createdSlug: "",
      });
    } else if (name === "team_refer" && isRecord(structured.referral)) {
      const referral = structured.referral;
      const id = text(referral.id);
      const to = identity(referral.to);
      if (!id || !to || seen.has(id)) continue;
      seen.add(id);
      cards.push({ kind: "referral", id, to, message: text(referral.message), why: text(referral.why), state: "open" });
    }
  }
  return cards;
}

/**
 * Settle each card's state. The person's recorded answer wins; without one, a
 * later message from the person closes the pills (the card stays as a record,
 * shown as declined or continued), and an offer with no later message is open.
 */
export function resolveTeamCards(cards: readonly TeamCard[], states: TeamStates | null, laterPersonMessage: boolean): TeamCard[] {
  return cards.map((card) => {
    if (card.kind === "suggestion") {
      const recorded = states?.suggestions.find((entry) => entry.id === card.id);
      if (recorded?.state === "accepted") return { ...card, state: "added", createdSlug: recorded.createdSlug };
      if (recorded?.state === "declined") return { ...card, state: "declined" };
      return laterPersonMessage ? { ...card, state: "declined" } : card;
    }
    const recorded = states?.referrals.find((entry) => entry.id === card.id);
    if (recorded?.state === "asked") return { ...card, state: "asked" };
    if (recorded?.state === "continued") return { ...card, state: "continued" };
    return laterPersonMessage ? { ...card, state: "continued" } : card;
  });
}

/** The pill text that becomes the person's message when they keep the coworker on it. */
export function continueWithReply(coworkerName: string): string {
  return `Go ahead, ${coworkerName}.`;
}

/** "Suggested by Nova · Customer support" — the small print under a proposed teammate. */
export function suggestionSmallPrint(card: SuggestionCard, proposerName: string): string {
  return [proposerName ? `Suggested by ${proposerName}` : "Suggested", card.role].filter(Boolean).join(" · ");
}

/** "Editor could take this · Writing and content" — the small print on a hand-over offer. */
export function referralSmallPrint(card: ReferralCard): string {
  return [`${card.to.name} could take this`, card.to.role].filter(Boolean).join(" · ");
}

/** The one quiet line a newcomer's empty conversation opens with, when a teammate proposed it: "Nova suggested me — the support inbox comes up every morning." */
export function newcomerLine(coworker: { suggestedBy: { slug: string; why: string } | null }, proposerName: string): string {
  if (!coworker.suggestedBy || !proposerName) return "";
  const why = coworker.suggestedBy.why.trim().replace(/\.$/, "");
  if (!why) return `${proposerName} suggested me.`;
  return `${proposerName} suggested me — ${why.charAt(0).toLowerCase()}${why.slice(1)}.`;
}

type TeamStepOutcome = { label: string; doing: string };

function firstLine(output: unknown): string {
  const content = keptResult({ output, metadata: {} })?.content.find((item) => isRecord(item) && typeof item.text === "string");
  const source = isRecord(content) && typeof content.text === "string" ? content.text : typeof output === "string" ? output : "";
  return source.split("\n")[0]?.trim() ?? "";
}

/**
 * A team tool call as the receipt line reads it: "Checked the team", "Offered
 * to pass this to Editor", "Suggested a teammate · Care", and for the guards
 * "Checked the team · Editor already covers this" or "Checked the team · you
 * asked to keep this here". Never a raw id or slug.
 */
export function describeTeamStep(
  name: TeamToolName,
  call: { input: Record<string, unknown>; output: unknown; metadata: Record<string, unknown> },
  state: "running" | "done" | "failed",
): TeamStepOutcome {
  const structured = keptResult(call)?.structuredContent ?? null;
  if (name === "team_list") {
    return { label: state === "failed" ? "Couldn't check the team" : state === "running" ? "Checking the team" : "Checked the team", doing: "checking the team" };
  }
  if (name === "team_refer") {
    const to = isRecord(structured?.referral) ? identity(structured.referral.to)?.name ?? "" : "";
    const wanted = to || text(call.input.to);
    if (state === "failed") return { label: wanted ? `Couldn't offer to pass this to ${wanted}` : "Couldn't offer to pass this on", doing: "offering to pass this on" };
    if (state === "running") return { label: "Offering to pass this on", doing: "offering to pass this on" };
    if (isRecord(structured?.kept)) return { label: "Checked the team · you asked to keep this here", doing: "offering to pass this on" };
    return { label: wanted ? `Offered to pass this to ${wanted}` : "Offered to pass this on", doing: "offering to pass this on" };
  }
  if (state === "failed") return { label: "Couldn't suggest a teammate", doing: "thinking about the team" };
  if (state === "running") return { label: "Thinking about the team", doing: "thinking about the team" };
  if (isRecord(structured?.suggestion)) {
    const suggested = text(structured.suggestion.name);
    return { label: suggested ? `Suggested a teammate · ${suggested}` : "Suggested a teammate", doing: "thinking about the team" };
  }
  if (isRecord(structured?.existing)) {
    const who = structured.self === true ? "that is its own job" : `${text(structured.existing.name) || "a teammate"} already covers this`;
    return { label: `Checked the team · ${who}`, doing: "thinking about the team" };
  }
  if (isRecord(structured?.declined)) return { label: "Checked the team · you said not now to this one", doing: "thinking about the team" };
  if (text(structured?.limit) === "daily") return { label: "Checked the team · one suggestion a day", doing: "thinking about the team" };
  const line = firstLine(call.output);
  return { label: line ? `Checked the team · ${line.replace(/\.$/, "")}` : "Checked the team", doing: "thinking about the team" };
}
