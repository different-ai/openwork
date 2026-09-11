import type { TextPartInput } from "@opencode-ai/sdk/v2/client";
import type { ComposerPart } from "@/app/types";
import { appMentionInstruction } from "../surface/composer/app-mentions";
import { computerMentionInstruction } from "../surface/composer/computer-mentions";
import { connectSkillPrompt, encodeConnectSkillToken } from "../surface/composer/connect-skill-token";

type InstructionMention = Extract<ComposerPart, { type: "computer" | "app" | "skill" | "connect-skill" }>;

/** Keep generated instructions out of user text in every send path. */
export function mentionPromptParts(part: InstructionMention): [TextPartInput, TextPartInput & { synthetic: true }] {
  const { label, instruction } = mentionContent(part);
  return [{
    type: "text",
    text: label,
    ...(part.type === "connect-skill" ? { metadata: { openworkComposerToken: encodeConnectSkillToken(part) } } : {}),
  }, {
    type: "text", text: instruction, synthetic: true,
    // Preserve selection identity through every send path. v1 still receives
    // the instruction; the v2 adapter replaces it with a native attachment.
    ...(part.type === "skill" ? { metadata: { openworkSelectedSkill: { name: part.name } } } : {}),
    ...(part.type === "connect-skill" ? { metadata: { openworkSelectedSkill: { id: part.capability } } } : {}),
  }];
}

function mentionContent(part: InstructionMention): { label: string; instruction: string } {
  switch (part.type) {
    case "computer":
      return { label: `@${part.target}`, instruction: computerMentionInstruction(part.target) };
    case "app":
      return { label: `@${part.name}`, instruction: appMentionInstruction(part.name) };
    case "skill":
      return { label: `[skill ${part.name}]`, instruction: `Load [skill ${part.name}] and follow its instructions.` };
    case "connect-skill":
      return { label: `/${part.slug}`, instruction: connectSkillPrompt(part) };
  }
}
