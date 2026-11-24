import type { UIMessage } from "ai";

import type { ComposerMentionKind } from "./mention-encoding";
import { encodeComposerMentionValue } from "./mention-encoding";
import { connectSkillPrompt } from "./connect-skill-token";
import { CONNECTOR_PROMPT_HISTORY } from "./connector-token";
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

export type SentToken =
  | { kind: "pill"; pill: ComposerPill }
  | { kind: "agent"; name: string }
  | { kind: "file"; path: string };

export type SentSegment = string | SentToken;

export function agentMentionInstruction(name: string) {
  return `Use the above message and context to generate a prompt and call the task tool with subagent: ${name}`;
}

export function fileMentionInstruction(path: string) {
  return `The user mentioned the file ${path}. Read it when it helps with the request.`;
}

export function mentionText(value: string) {
  return `@${value}`;
}

const SLOT = (name: string) => `OPENWORKSLOT${name}OPENWORKSLOT`;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function templateRegExp(names: readonly string[], render: (slots: Record<string, string>) => string) {
  const slots = Object.fromEntries(names.map((name) => [name, SLOT(name)]));
  const rendered = render(slots).trimEnd();
  let source = escapeRegExp(rendered);
  for (const name of names) {
    let first = true;
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
      re: templateRegExp(["name", "marketplace", "capability"], (slots) => connectSkillPrompt({ slug: "", name: slots.name!, marketplace: slots.marketplace!, capability: slots.capability! })),
      toToken: (groups) => groups.name && groups.marketplace && groups.capability
        ? pill({ kind: "connect-skill", slug: "", name: groups.name, marketplace: groups.marketplace, capability: groups.capability })
        : null,
    },
    ...CONNECTOR_PROMPT_HISTORY.map((render): InstructionMatcher => ({
      re: templateRegExp(["name"], (slots) => render(slots.name!)),
      toToken: (groups) => groups.name ? pill({ kind: "connector", name: groups.name }) : null,
    })),
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

function locate(words: string, from: number, token: SentToken): { index: number; length: number; token: SentToken } | null {
  if (token.kind === "pill" && token.pill.kind === "connect-skill") {
    const { pill } = token;
    let fallback: RegExpExecArray | null = null;
    SLASH_TOKEN_RE.lastIndex = from;
    for (let match = SLASH_TOKEN_RE.exec(words); match; match = SLASH_TOKEN_RE.exec(words)) {
      if (match[1] === slugify(pill.name)) { fallback = match; break; }
      fallback ??= match;
    }
    if (!fallback?.[1]) return null;
    return { index: fallback.index, length: fallback[0].length, token: { kind: "pill", pill: { ...pill, slug: fallback[1] } } };
  }
  const visible = token.kind === "pill" ? composerPillText(token.pill) : mentionText(token.kind === "agent" ? token.name : token.path);
  const index = words.indexOf(visible, from);
  return index < 0 ? null : { index, length: visible.length, token };
}

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

export type SentMessageDraft = {
  text: string;
  mentions: Record<string, ComposerMentionKind>;
  pasteParts: PastedTextChip[];
};

function opencodeMetadata(part: UIMessage["parts"][number]): Record<string, unknown> | null {
  if (!("providerMetadata" in part)) return null;
  const metadata = part.providerMetadata?.opencode;
  return metadata && typeof metadata === "object" ? metadata as Record<string, unknown> : null;
}

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
