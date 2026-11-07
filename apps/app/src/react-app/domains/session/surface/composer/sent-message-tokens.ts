import type { UIMessage } from "ai";

import type { ComposerMentionKind } from "./mention-encoding";
import { encodeComposerMentionValue } from "./mention-encoding";
import { connectSkillPrompt } from "./connect-skill-token";
import { connectorPrompt } from "./connector-token";
import { sessionReferencePrompt } from "./session-reference-token";
import { createPastedTextChip, type PastedTextChip } from "./pasted-text";
import {
  composerPillText,
  composerPillToken,
  computerInstructionHistory,
  readComposerPill,
  splitComposerPillText,
  type ComposerPill,
} from "./composer-pills";

/**
 * The round trip of a composer token through a sent user turn.
 *
 * The composer draws skills, Connect skills, connectors, computers, task
 * references, agents, file mentions and pasted text as chips. A send turns
 * each into visible text (what the person wrote) plus, for most, a hidden
 * instruction for the model. The transcript must draw the same chip again,
 * and Edit must put the same chip back in the composer.
 *
 * v1 keeps every token as its own tagged part, so its metadata says what it
 * was. Engines that store a turn as one prompt string (OpenCode v2) keep only
 * the visible words and the hidden instructions. This module decodes those
 * back into the same tokens, from the same templates the send path used, so
 * there is one encoder and one decoder and the two cannot drift.
 */
export type SentToken =
  | { kind: "pill"; pill: ComposerPill }
  | { kind: "agent"; name: string }
  | { kind: "file"; path: string };

export type SentSegment = string | SentToken;

/**
 * Model-facing text for an `@agent` mention when the engine has no agent part.
 * Same wording OpenCode v1 adds for an agent part.
 */
export function agentMentionInstruction(name: string) {
  return `Use the above message and context to generate a prompt and call the task tool with subagent: ${name}`;
}

/** Model-facing text for an `@file` mention when the engine cannot inline the file. */
export function fileMentionInstruction(path: string) {
  return `The user mentioned the file ${path}. Read it when it helps with the request.`;
}

/** The visible text a mention contributes to the prompt. */
export function mentionText(value: string) {
  return `@${value}`;
}

// ---------------------------------------------------------------------------
// Decoding instructions back into tokens

const SLOT = (name: string) => `OPENWORKSLOT${name}OPENWORKSLOT`;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A regex matching `render(slots)` for any slot values. The first occurrence of
 * a slot captures it; later occurrences must repeat the same value.
 */
function templateRegExp(names: readonly string[], render: (slots: Record<string, string>) => string) {
  const slots = Object.fromEntries(names.map((name) => [name, SLOT(name)]));
  const rendered = render(slots).trimEnd();
  let source = escapeRegExp(rendered);
  for (const name of names) {
    let first = true;
    // A slot that ends the template runs to the end of its line; others stop
    // at the template text that follows them.
    const pattern = rendered.endsWith(SLOT(name)) ? "[^\\n]+" : "[^\\n]+?";
    source = source.replaceAll(escapeRegExp(SLOT(name)), () => {
      if (!first) return `\\k<${name}>`;
      first = false;
      return `(?<${name}>${pattern})`;
    });
  }
  return new RegExp(source, "g");
}

type InstructionMatcher = { re: RegExp; toToken: (groups: Record<string, string>) => SentToken | null };

let matchers: InstructionMatcher[] | null = null;

function instructionMatchers(): InstructionMatcher[] {
  if (matchers) return matchers;
  const pill = (value: ComposerPill): SentToken => ({ kind: "pill", pill: value });
  matchers = [
    {
      // The slug is not part of the instruction; it is recovered from the words.
      re: templateRegExp(["name", "marketplace", "capability"], (slots) => connectSkillPrompt({ slug: "", name: slots.name!, marketplace: slots.marketplace!, capability: slots.capability! })),
      toToken: (groups) => groups.name && groups.marketplace && groups.capability
        ? pill({ kind: "connect-skill", slug: "", name: groups.name, marketplace: groups.marketplace, capability: groups.capability })
        : null,
    },
    { re: templateRegExp(["name"], (slots) => connectorPrompt(slots.name!)), toToken: (groups) => groups.name ? pill({ kind: "connector", name: groups.name }) : null },
    ...(["cloud", "desktop"] as const).flatMap((target) => computerInstructionHistory(target).map((instruction): InstructionMatcher => ({
      re: new RegExp(escapeRegExp(instruction), "g"),
      toToken: () => pill({ kind: "computer", target }),
    }))),
    ...[true, false].map((titled): InstructionMatcher => ({
      re: templateRegExp(titled ? ["title", "sessionId", "workspaceId"] : ["sessionId", "workspaceId"], (slots) => sessionReferencePrompt({
        workspaceId: slots.workspaceId!, sessionId: slots.sessionId!, title: titled ? slots.title! : "",
      })),
      toToken: (groups) => {
        const parsed = readComposerPill({ kind: "session", workspaceId: groups.workspaceId, sessionId: groups.sessionId, title: groups.title ?? "" });
        return parsed ? pill(parsed) : null;
      },
    })),
    { re: templateRegExp(["name"], (slots) => agentMentionInstruction(slots.name!)), toToken: (groups) => groups.name ? { kind: "agent", name: groups.name } : null },
    { re: templateRegExp(["path"], (slots) => fileMentionInstruction(slots.path!)), toToken: (groups) => groups.path ? { kind: "file", path: groups.path } : null },
  ];
  return matchers;
}

/** Tokens named by hidden instructions, in the order they were sent. */
export function sentTokensFromInstructions(context: string): SentToken[] {
  const found: { index: number; token: SentToken }[] = [];
  for (const matcher of instructionMatchers()) {
    matcher.re.lastIndex = 0;
    for (const match of context.matchAll(matcher.re)) {
      const token = matcher.toToken(match.groups ?? {});
      if (token) found.push({ index: match.index, token });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((item) => item.token);
}

function slugify(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

const SLASH_TOKEN_RE = /(?<!\S)\/([A-Za-z0-9_-]+)(?!\S)/g;

/** Where a token's visible text sits in the words, at or after `from`. */
function locate(words: string, from: number, token: SentToken): { index: number; length: number; token: SentToken } | null {
  if (token.kind === "pill" && token.pill.kind === "connect-skill") {
    const { pill } = token;
    // The instruction does not include the trigger slug, so only recover the
    // visible text when it matches the skill's slugged name.
    SLASH_TOKEN_RE.lastIndex = from;
    for (let match = SLASH_TOKEN_RE.exec(words); match; match = SLASH_TOKEN_RE.exec(words)) {
      if (match[1] === slugify(pill.name)) {
        return { index: match.index, length: match[0].length, token: { kind: "pill", pill: { ...pill, slug: match[1] } } };
      }
    }
    return null;
  }
  const visible = token.kind === "pill" ? composerPillText(token.pill) : mentionText(token.kind === "agent" ? token.name : token.path);
  // Parts are joined without separators, so a mention can follow a word directly.
  const index = words.indexOf(visible, from);
  return index < 0 ? null : { index, length: visible.length, token };
}

/**
 * Split the visible words of a one-string turn into text and tokens, using the
 * hidden instructions that travelled with it. A token whose visible text is
 * not found stays plain text (removed skills, edited history, older sends).
 */
export function decodeSentWords(words: string, context: string | null): SentSegment[] {
  const tokens = context ? sentTokensFromInstructions(context) : [];
  const segments: SentSegment[] = [];
  let cursor = 0;
  for (const token of tokens) {
    const found = locate(words, cursor, token);
    if (!found) continue;
    if (found.index > cursor) segments.push(words.slice(cursor, found.index));
    segments.push(found.token);
    cursor = found.index + found.length;
  }
  if (cursor < words.length) segments.push(words.slice(cursor));
  return segments;
}

// ---------------------------------------------------------------------------
// Sent message -> composer draft (Edit message)

export type SentMessageDraft = {
  /** Draft text with chip tokens, as the composer stores it. */
  text: string;
  mentions: Record<string, ComposerMentionKind>;
  pasteParts: PastedTextChip[];
};

function opencodeMetadata(part: UIMessage["parts"][number]): Record<string, unknown> | null {
  if (!("providerMetadata" in part)) return null;
  const metadata = part.providerMetadata?.opencode;
  return metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : null;
}

/** What a sent text part shows as a chip, if anything; shared by the transcript and Edit. */
export function sentTextPartToken(part: UIMessage["parts"][number]): SentToken | { kind: "pasted" } | null {
  if (part.type !== "text") return null;
  const metadata = opencodeMetadata(part);
  if (!metadata) return null;
  const pill = readComposerPill(metadata.composerPill);
  if (pill) return { kind: "pill", pill };
  if (metadata.pastedText === true) return { kind: "pasted" };
  if (typeof metadata.agentMention === "string" && metadata.agentMention) return { kind: "agent", name: metadata.agentMention };
  if (typeof metadata.fileMention === "string" && metadata.fileMention) return { kind: "file", path: metadata.fileMention };
  return null;
}

/**
 * The composer draft that recreates a sent message: every chip comes back as
 * the same chip, and plain text stays as typed. Attachments carry bytes the
 * transcript no longer holds, so they are not restored.
 */
export function composerDraftFromSentParts(parts: UIMessage["parts"]): SentMessageDraft {
  const mentions: Record<string, ComposerMentionKind> = {};
  const pasteParts: PastedTextChip[] = [];
  const pieces: string[] = [];
  const pushPill = (pill: ComposerPill) => {
    if (pill.kind === "computer") mentions[pill.target] = "computer";
    pieces.push(composerPillToken(pill));
  };
  for (const part of parts) {
    if (part.type !== "text" || !part.text) continue;
    const token = sentTextPartToken(part);
    if (!token) {
      for (const segment of splitComposerPillText(part.text)) {
        if (typeof segment === "string") pieces.push(segment);
        else pushPill(segment);
      }
      continue;
    }
    switch (token.kind) {
      case "pill":
        pushPill(token.pill);
        break;
      case "pasted": {
        const chip = createPastedTextChip(part.text);
        pasteParts.push(chip);
        pieces.push(`[pasted text ${chip.label}]`);
        break;
      }
      case "agent":
        mentions[token.name] = "agent";
        pieces.push(mentionText(encodeComposerMentionValue(token.name)));
        break;
      case "file":
        mentions[token.path] = "file";
        pieces.push(mentionText(encodeComposerMentionValue(token.path)));
        break;
    }
  }
  return { text: pieces.join("").trim(), mentions, pasteParts };
}
