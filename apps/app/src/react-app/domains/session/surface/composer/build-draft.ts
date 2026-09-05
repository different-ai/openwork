import type { ComposerAttachment, ComposerDraft, ComposerPart } from "@/app/types";
import { isComputerTarget } from "./computer-mentions";
import { decodeComposerMentionValue, encodeComposerMentionValue, type ComposerMentionKind } from "./mention-encoding";
import { parseSlashCommandInvocation } from "./slash-command";
import { connectSkillPrompt, parseConnectSkillToken } from "./connect-skill-token";
import { resolvePastedTextPlaceholders, type PastedTextChip } from "./pasted-text";

/** The same prompt semantics for the composer and Voice Mode's text/transcripts. */
export function buildComposerDraft(text: string, {
  attachments = [], mentions = {}, pasteParts = [], revertMessageId,
}: {
  attachments?: ComposerAttachment[];
  mentions?: Record<string, ComposerMentionKind>;
  pasteParts?: PastedTextChip[];
  revertMessageId?: string;
} = {}): ComposerDraft {
  const parts = text.split(/(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[connect-skill [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/).flatMap((segment, index, segments): ComposerPart[] => {
    if (!segment) return [];
    const attachmentMatch = segment.match(/^\[attachment (.+)\]$/);
    if (attachmentMatch) {
      // Attachment chips are visual tokens only; bytes travel via draft.attachments.
      return [];
    }
    const pasteMatch = segment.match(/^\[pasted text (.+)\]$/);
    if (pasteMatch) {
      const target = pasteParts.find((item) => item.label === pasteMatch[1]);
      if (target) {
        return [{ type: "paste", id: target.id, label: target.label, text: target.text, lines: target.lines } satisfies ComposerDraft["parts"][number]];
      }
    }
    const connectSkill = parseConnectSkillToken(segment);
    if (connectSkill) {
      return [{ type: "text", text: connectSkillPrompt(connectSkill) } satisfies ComposerDraft["parts"][number]];
    }
    const skillMatch = segment.match(/^\[skill (.+)\]$/);
    if (skillMatch?.[1]) {
      return [{ type: "skill", name: skillMatch[1] } satisfies ComposerDraft["parts"][number]];
    }
    if (segment.startsWith("@")) {
      const value = decodeComposerMentionValue(segment.slice(1));
      const kind = mentions[value];
      if (isComputerTarget(value) && (!kind || kind === "computer") && (index <= 1 && !segments[0] || /\s$/.test(segments[index - 1] ?? ""))) {
        return [{ type: "computer", target: value } satisfies ComposerDraft["parts"][number]];
      }
      if (kind === "agent") return [{ type: "agent", name: value } satisfies ComposerDraft["parts"][number]];
      if (kind === "file") return [{ type: "file", path: value, label: value } satisfies ComposerDraft["parts"][number]];
      if (kind === "app") return [{ type: "app", name: value } satisfies ComposerDraft["parts"][number]];
    }
    return [{ type: "text", text: segment } satisfies ComposerDraft["parts"][number]];
  });
  // Expand paste placeholders in resolvedText so the model receives
  // the actual pasted content instead of "[pasted text <label>]".
  let resolved = resolvePastedTextPlaceholders(text, pasteParts);
  resolved = resolved.replace(/\[attachment [^\]]+\]/g, "");
  resolved = resolved.replace(/\[connect-skill [^\]]+\]/g, (match) => {
    const token = parseConnectSkillToken(match);
    return token ? connectSkillPrompt(token) : match;
  });
  resolved = resolved.replace(/\[skill ([^\]]+)\]/g, (_match, name: string) => `the \"${name}\" skill`);
  for (const value of Object.keys(mentions)) {
    resolved = resolved.replaceAll(`@${encodeComposerMentionValue(value)}`, `@${value}`);
  }
  const slashCommand = parseSlashCommandInvocation(resolved);
  return {
    mode: "prompt",
    parts,
    attachments,
    text,
    resolvedText: resolved,
    command: slashCommand ?? undefined,
    revertMessageId,
  };
}
