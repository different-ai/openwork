import type { ToolCall, ToolResult, ToolSpec } from "./types.js"

/**
 * A reaction to the person's latest message: one emoji, the way people react to each other in chat. The runner only
 * checks that it is one emoji and keeps the call in the transcript; the caller shows it (Workbot puts it on the
 * person's message). Offered only to sessions created with `reactions: true`.
 */
export const REACTION_TOOL_NAMES: ReadonlySet<string> = new Set(["react"])

export const REACTION_TOOLS: ToolSpec[] = [
  {
    name: "react",
    description:
      "React to the person's latest message with one emoji, the way a colleague does in chat. It shows on their message right away. Use it when it fits, at most once per message. Set final when the reaction is your whole reply (thanks, ok, sounds good): your turn ends there, with nothing written.",
    inputSchema: {
      type: "object",
      properties: {
        emoji: { type: "string", description: "Exactly one emoji, e.g. 👍" },
        final: { type: "boolean", description: "True when this reaction is your whole reply." },
      },
      required: ["emoji"],
      additionalProperties: false,
    },
  },
]

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** True for exactly one emoji (including ZWJ sequences, skin tones and flags). */
export function isOneEmoji(text: string) {
  if (!text || text.length > 32) return false
  const parts = [...graphemes.segment(text)]
  return parts.length === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(text)
}

export function runReactionTool(input: Record<string, unknown>): ToolResult {
  const emoji = typeof input.emoji === "string" ? input.emoji.trim() : ""
  if (!isOneEmoji(emoji)) return { output: "React with exactly one emoji, such as 👍.", isError: true }
  return { output: `Reacted with ${emoji}; they see it on their message.`, isError: false }
}

/**
 * A step that only reacted, with `final`, is the whole reply: the turn ends there instead of asking the model for
 * words it was told not to write (models tend to add "You're welcome!" anyway).
 */
export function reactionEndsTurn(calls: ToolCall[], outcomes: ToolResult[]) {
  return (
    calls.length > 0 &&
    calls.every((call, index) => REACTION_TOOL_NAMES.has(call.name) && outcomes[index]?.isError === false) &&
    calls.some((call) => call.input.final === true)
  )
}
