import type { TextPartInput } from "@opencode-ai/sdk/v2/client";

import type { ComposerPart } from "@/app/types";
import { appMentionInstruction } from "./app-mentions";
import { humanizeCapabilityName } from "./composer-plus-menu-model";
import { computerMentionInstruction, isComputerTarget, type ComputerTarget } from "./computer-mentions";
import { connectSkillPrompt, encodeConnectSkillToken, parseConnectSkillToken } from "./connect-skill-token";
import { connectorPrompt, encodeConnectorToken, parseConnectorToken } from "./connector-token";

/**
 * One source of truth for composer pills: the skills, connectors, apps and
 * computers picked from the composer `+` menu or `@` mentions.
 *
 * A pill has three faces, and each is owned here:
 * - its draft token (what the composer stores and re-renders as a chip),
 * - its visible text (what the user message holds, shown as the same chip),
 * - its model instruction (sent as a synthetic part, never shown).
 *
 * Every send path, the user message bubble, the queued-message list and the
 * composer read from this module, so a pill in the composer stays a pill in the
 * transcript and its instruction never expands into the user's text.
 */
export type ComposerPill =
  | { kind: "skill"; name: string }
  | { kind: "connect-skill"; slug: string; name: string; marketplace: string; capability: string }
  | { kind: "connector"; name: string }
  | { kind: "app"; name: string }
  | { kind: "computer"; target: ComputerTarget };

type ComposerPillPart = Extract<ComposerPart, { type: "skill" | "connect-skill" | "connector" | "app" | "computer" }>;

/** Splits a draft into text and token segments (one capture group, keep it for `split`). */
export const COMPOSER_DRAFT_TOKEN_RE = /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|\[connector [^\]]+\]|@[^\s@]+)/;

const SKILL_TOKEN_RE = /^\[skill (.+)\]$/;

/** Neutral token chip used for skills and connectors (DESIGN.md V2). */
export const COMPOSER_TOKEN_CLASS = "inline-flex items-center rounded-md bg-gray-3 px-1.5 py-0.5 text-xs font-medium text-gray-12";

/** `@` mention chips, keyed by what the mention refers to. */
export const COMPOSER_MENTION_CLASS = {
  computer: "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11",
  file: "inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-1 text-xs font-medium text-gray-11",
  agent: "inline-flex items-center rounded-full border border-sky-6/35 bg-sky-3/20 px-2.5 py-1 text-xs font-medium text-sky-11",
  app: "inline-flex items-center rounded-full border border-cyan-6/35 bg-cyan-3/20 px-2.5 py-1 text-xs font-medium text-cyan-11",
} as const;

/** The pill a `[skill …]`, `[connect-skill …]` or `[connector …]` draft segment stands for. */
export function parseComposerPillToken(segment: string): ComposerPill | null {
  const connectSkill = parseConnectSkillToken(segment);
  if (connectSkill) return { kind: "connect-skill", ...connectSkill };
  const connector = parseConnectorToken(segment);
  if (connector) return { kind: "connector", name: connector };
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
    case "app":
      return { kind: "app", name: part.name };
    case "computer":
      return { kind: "computer", target: part.target };
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
    case "app":
      return `@${pill.name}`;
    case "computer":
      return `@${pill.target}`;
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
    default:
      return composerPillToken(pill);
  }
}

/** The chip label, identical in the composer and the transcript. */
export function composerPillLabel(pill: ComposerPill): string {
  switch (pill.kind) {
    case "skill":
      return humanizeCapabilityName(pill.name);
    case "connect-skill":
      return humanizeCapabilityName(pill.slug);
    case "connector":
      return pill.name;
    case "app":
      return `@${pill.name}`;
    case "computer":
      return `@${pill.target}`;
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
    case "app":
      return `@${pill.name}`;
    case "computer":
      return `@${pill.target}`;
  }
}

export function composerPillClassName(pill: ComposerPill): string {
  switch (pill.kind) {
    case "app":
      return COMPOSER_MENTION_CLASS.app;
    case "computer":
      return COMPOSER_MENTION_CLASS.computer;
    default:
      return COMPOSER_TOKEN_CLASS;
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
    case "app":
      return appMentionInstruction(pill.name);
    case "computer":
      return computerMentionInstruction(pill.target);
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
    },
  }, {
    type: "text",
    text: composerPillInstruction(pill),
    synthetic: true,
    // Preserve selection identity through every send path. v1 still receives
    // the instruction; the v2 adapter replaces it with a native attachment.
    ...(pill.kind === "skill" ? { metadata: { openworkSelectedSkill: { name: pill.name } } } : {}),
    ...(pill.kind === "connect-skill" ? { metadata: { openworkSelectedSkill: { id: pill.capability } } } : {}),
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
  if (kind === "skill" || kind === "connector" || kind === "app") {
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

function decodeJsonString(value: string) {
  try {
    const decoded: unknown = JSON.parse(`"${value}"`);
    return typeof decoded === "string" ? decoded : value;
  } catch {
    return value;
  }
}

let pillMatchers: PillMatcher[] | null = null;

function getPillMatchers(): PillMatcher[] {
  if (pillMatchers) return pillMatchers;
  pillMatchers = [
    // Draft tokens that reached the transcript as text.
    { re: /\[connect-skill [^\]]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    { re: /\[connector [^\]\n]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    { re: /\[skill [^\]\n]+\]/g, toPill: (match) => parseComposerPillToken(match[0]) },
    // Instructions that older sends, or clients that flatten parts into one
    // string, left inline in the user's text.
    { re: templateRegExp(skillInstruction), toPill: (match) => match[1] ? { kind: "skill", name: match[1] } : null },
    { re: templateRegExp(connectorPrompt), toPill: (match) => match[1] ? { kind: "connector", name: match[1] } : null },
    { re: templateRegExp(appMentionInstruction), toPill: (match) => match[1] ? { kind: "app", name: decodeJsonString(match[1]) } : null },
    ...(["cloud", "desktop"] as const).map((target): PillMatcher => ({
      re: new RegExp(escapeRegExp(computerMentionInstruction(target)), "g"),
      toPill: () => ({ kind: "computer", target }),
    })),
  ];
  return pillMatchers;
}

function isInstructionMatch(pill: ComposerPill, text: string) {
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
