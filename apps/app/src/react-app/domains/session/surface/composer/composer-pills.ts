import type { TextPartInput } from "@opencode-ai/sdk/v2/client";

import type { ComposerPart } from "@/app/types";
import { computerMentionInstruction, isComputerTarget, type ComputerTarget } from "./computer-mentions";
import { connectSkillPrompt, encodeConnectSkillToken, parseConnectSkillToken } from "./connect-skill-token";
import { connectorPrompt, encodeConnectorToken, parseConnectorToken } from "./connector-token";
import {
  encodeSessionReferenceToken,
  parseSessionReferenceToken,
  sessionReferencePrompt,
  sessionReferenceText,
} from "./session-reference-token";

/**
 * One source of truth for composer pills: the skills, connectors and
 * computers picked from the composer `+` menu or `@` mentions, and the tasks
 * referenced from the `#` menu.
 *
 * A pill has three faces, and each is owned here:
 * - its draft token (what the composer stores and re-renders as a chip),
 * - its visible text (what the user message holds, shown as the same chip),
 * - its model instruction (sent as a synthetic part, never shown).
 * How the chip looks lives in composer-chips.
 *
 * Every send path, the user message bubble, the queued-message list and the
 * composer read from this module, so a pill in the composer stays a pill in the
 * transcript and its instruction never expands into the user's text.
 */
export type ComposerPill =
  | { kind: "skill"; name: string }
  | { kind: "connect-skill"; slug: string; name: string; marketplace: string; capability: string }
  | { kind: "connector"; name: string }
  | { kind: "computer"; target: ComputerTarget }
  | { kind: "session"; workspaceId: string; sessionId: string; title: string };

type ComposerPillPart = Extract<ComposerPart, { type: "skill" | "connect-skill" | "connector" | "computer" | "session" }>;

/** Splits a draft into text and token segments (one capture group, keep it for `split`). */
export const COMPOSER_DRAFT_TOKEN_RE = /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|\[connector [^\]]+\]|\[session [^\]\n]+\]|@[^\s@]+)/;

/** Pill tokens whose visible text replaces them in the resolved draft. */
export const COMPOSER_PILL_TOKEN_GLOBAL_RE = /\[connect-skill [^\]]+\]|\[skill [^\]]+\]|\[connector [^\]]+\]|\[session [^\]\n]+\]/g;

const SKILL_TOKEN_RE = /^\[skill (.+)\]$/;

/** Neutral chip for slash commands; pills and mentions use composer-chips badges. */
export const COMPOSER_TOKEN_CLASS = "inline-flex items-center rounded-md bg-gray-3 px-1.5 py-0.5 text-xs font-medium text-gray-12";

/** The pill a `[skill …]`, `[connect-skill …]` or `[connector …]` draft segment stands for. */
export function parseComposerPillToken(segment: string): ComposerPill | null {
  const connectSkill = parseConnectSkillToken(segment);
  if (connectSkill) return { kind: "connect-skill", ...connectSkill };
  const connector = parseConnectorToken(segment);
  if (connector) return { kind: "connector", name: connector };
  const session = parseSessionReferenceToken(segment);
  if (session) return { kind: "session", ...session };
  const skill = segment.match(SKILL_TOKEN_RE)?.[1];
  return skill ? { kind: "skill", name: skill } : null;
}

export function composerPillFromPart(part: ComposerPillPart): ComposerPill {
  switch (part.type) {
    case "skill":
      return { kind: "skill", name: part.name };
    case "connect-skill":
      return { kind: "connect-skill", slug: part.slug, name: part.name, marketplace: part.marketplace, capability: part.capability };
    case "connector":
      return { kind: "connector", name: part.name };
    case "computer":
      return { kind: "computer", target: part.target };
    case "session":
      return { kind: "session", workspaceId: part.workspaceId, sessionId: part.sessionId, title: part.title };
  }
}

/** The draft token the composer stores for this pill. */
export function composerPillToken(pill: ComposerPill): string {
  switch (pill.kind) {
    case "skill":
      return `[skill ${pill.name}]`;
    case "connect-skill":
      return encodeConnectSkillToken(pill);
    case "connector":
      return encodeConnectorToken(pill.name);
    case "computer":
      return `@${pill.target}`;
    case "session":
      // Ids are validated when the pill is created or parsed.
      return encodeSessionReferenceToken(pill) ?? "";
  }
}

/**
 * The user-visible text the pill contributes to the message. It is short and
 * readable on its own (copy, edit, clients that cannot render pills), and it is
 * what the model sees as the user's words next to the synthetic instruction.
 */
export function composerPillText(pill: ComposerPill): string {
  switch (pill.kind) {
    case "connect-skill":
      return `/${pill.slug}`;
    case "session":
      return sessionReferenceText(pill);
    default:
      return composerPillToken(pill);
  }
}

export function composerPillTitle(pill: ComposerPill): string {
  switch (pill.kind) {
    case "skill":
      return `Skill: ${pill.name}`;
    case "connect-skill":
      return `Skill: ${pill.name}`;
    case "connector":
      return `Connector: ${pill.name}`;
    case "computer":
      return `@${pill.target}`;
    case "session":
      return `Task: ${pill.title || pill.sessionId}`;
  }
}

/** Model-facing steering text. Only ever sent as a synthetic part. */
export function composerPillInstruction(pill: ComposerPill): string {
  switch (pill.kind) {
    case "skill":
      return skillInstruction(pill.name);
    case "connect-skill":
      return connectSkillPrompt(pill);
    case "connector":
      return connectorPrompt(pill.name);
    case "computer":
      return computerMentionInstruction(pill.target);
    case "session":
      return sessionReferencePrompt(pill);
  }
}

function skillInstruction(name: string) {
  return `Load [skill ${name}] and follow its instructions.`;
}

/**
 * The two prompt parts every send path emits for a pill: the visible text
 * (tagged with the pill so the transcript renders a chip) and the synthetic
 * instruction (hidden from the transcript).
 */
export function composerPillPromptParts(pill: ComposerPill): [TextPartInput, TextPartInput & { synthetic: true }] {
  return [{
    type: "text",
    text: composerPillText(pill),
    metadata: {
      openworkComposerPill: pill,
      // Prompt history recalls a Connect skill from its durable token.
      ...(pill.kind === "connect-skill" ? { openworkComposerToken: encodeConnectSkillToken(pill) } : {}),
      ...(pill.kind === "session" ? { openworkComposerToken: composerPillToken(pill) } : {}),
    },
  }, {
    type: "text",
    text: composerPillInstruction(pill),
    synthetic: true,
    // Preserve selection identity through every send path. v1 still receives
    // the instruction; the v2 adapter replaces it with a native attachment.
    ...(pill.kind === "skill" ? { metadata: { openworkSelectedSkill: { name: pill.name } } } : {}),
  }];
}

function stringField(value: object, key: string): string | null {
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field ? field : null;
}

/** Validate a pill read back from message metadata. */
export function readComposerPill(value: unknown): ComposerPill | null {
  if (!value || typeof value !== "object") return null;
  const kind = stringField(value, "kind");
  if (kind === "skill" || kind === "connector") {
    const name = stringField(value, "name");
    return name ? { kind, name } : null;
  }
  if (kind === "computer") {
    const target = stringField(value, "target");
    return target && isComputerTarget(target) ? { kind, target } : null;
  }
  if (kind === "connect-skill") {
    const slug = stringField(value, "slug");
    const name = stringField(value, "name");
    const marketplace = stringField(value, "marketplace");
    const capability = stringField(value, "capability");
    return slug && name && marketplace && capability ? { kind, slug, name, marketplace, capability } : null;
  }
  if (kind === "session") {
    const workspaceId = stringField(value, "workspaceId");
    const sessionId = stringField(value, "sessionId");
    const title = stringField(value, "title") ?? "";
    if (!workspaceId || !sessionId) return null;
    const token = encodeSessionReferenceToken({ workspaceId, sessionId, title });
    const parsed = token ? parseSessionReferenceToken(token) : null;
    return parsed ? { kind, ...parsed } : null;
  }
  return null;
}

export type ComposerPillTextSegment = string | ComposerPill;

type PillMatcher = { re: RegExp; toPill: (match: RegExpExecArray) => ComposerPill | null };

const TEMPLATE_SLOT = "OPENWORKPILLSLOT";

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex that matches `render(name)` for any name, capturing the name. */
function templateRegExp(render: (slot: string) => string) {
  let first = true;
  const source = escapeRegExp(render(TEMPLATE_SLOT)).replaceAll(TEMPLATE_SLOT, () => {
    if (!first) return "\\1";
    first = false;
    return "([^\\n\"\\]]+?)";
  });
  return new RegExp(source, "g");
}

let pillMatchers: PillMatcher[] | null = null;

function getPillMatchers(): PillMatcher[] {
  if (pillMatchers) return pillMatchers;
  pillMatchers = [
    // Draft tokens that reached the transcript as text.
    { re: /\[connect-skill [^\]]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    { re: /\[connector [^\]\n]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    { re: /\[skill [^\]\n]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    { re: /\[session [^\]\n]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    // Instructions that older sends, or clients that flatten parts into one
    // string, left inline in the user's text.
    { re: templateRegExp(skillInstruction), toPill: (match) => match[1] ? { kind: "skill", name: match[1] } : null },
    { re: templateRegExp(connectorPrompt), toPill: (match) => match[1] ? { kind: "connector", name: match[1] } : null },
    ...(["cloud", "desktop"] as const).flatMap((target) => computerInstructionHistory(target).map((instruction): PillMatcher => ({
      re: new RegExp(escapeRegExp(instruction), "g"),
      toPill: () => ({ kind: "computer", target }),
    }))),
  ];
  return pillMatchers;
}

/** Decode exact historical sends without offering the retired polling instruction on new sends. */
function computerInstructionHistory(target: "cloud" | "desktop"): string[] {
  const current = computerMentionInstruction(target);
  const legacyEnding = target === "cloud"
    ? "Return the session link and use remote-session:read to check replies."
    : "Use remote-session:read with commandId to check delivery. A delivered receipt means the task was started, not that it finished; return the desktop session reference.";
  return [current, current.replace(/OpenWork shows the started task.*(?=\]$)/, legacyEnding)];
}

function isInstructionMatch(pill: ComposerPill, text: string) {
  if (pill.kind === "computer") {
    return computerInstructionHistory(pill.target).includes(text);
  }
  return text === composerPillInstruction(pill);
}

/**
 * Split plain user-message text into text and pills. Recognizes pill tokens
 * and any expanded pill instruction, so no instruction is ever displayed as
 * the user's words. When an instruction directly follows its own visible text
 * (`[connector GitHub]This request is about…`) both collapse into one pill.
 */
export function splitComposerPillText(text: string): ComposerPillTextSegment[] {
  const matchers = getPillMatchers();
  const segments: ComposerPillTextSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let best: { index: number; length: number; pill: ComposerPill } | null = null;
    for (const matcher of matchers) {
      matcher.re.lastIndex = cursor;
      const match = matcher.re.exec(text);
      if (!match) continue;
      if (best && (match.index > best.index || (match.index === best.index && match[0].length <= best.length))) continue;
      const pill = matcher.toPill(match);
      if (pill) best = { index: match.index, length: match[0].length, pill };
    }
    if (!best) break;
    let before = text.slice(cursor, best.index);
    const matched = text.slice(best.index, best.index + best.length);
    const previous = segments.at(-1);
    const label = composerPillText(best.pill);
    if (isInstructionMatch(best.pill, matched)) {
      if (!before && previous && typeof previous !== "string" && composerPillText(previous) === label) {
        cursor = best.index + best.length;
        continue;
      }
      if (before.endsWith(label)) before = before.slice(0, -label.length);
    }
    if (before) segments.push(before);
    segments.push(best.pill);
    cursor = best.index + best.length;
  }
  if (cursor < text.length) segments.push(text.slice(cursor));
  return segments;
}
