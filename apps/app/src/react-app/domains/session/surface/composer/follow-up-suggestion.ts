import type { UIMessage } from "ai";

import { sessionErrorPresentationFromUIMessage } from "@/react-app/domains/session/sync/session-error";

/** What the model answers when it has no clear next message to offer. */
const NO_SUGGESTION = "NONE";
const REQUEST_LIMIT = 1_500;
const REPLY_LIMIT = 4_000;
/** Longer answers are explanations or several steps, not one message to send. */
const SUGGESTION_LIMIT = 120;

function messageText(message: UIMessage): string {
  return message.parts.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n").trim();
}

/**
 * The last exchange a follow-up can be suggested for: a finished reply with
 * text, and the request it answers. Null while the chat ends on anything else
 * (the person's own message, a failed turn, a reply with no text).
 */
export function followUpExchange(messages: readonly UIMessage[]): { replyId: string; request: string; reply: string } | null {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant" || sessionErrorPresentationFromUIMessage(last)) return null;
  const reply = messageText(last);
  const request = messages.findLast((message) => message.role === "user");
  if (!reply || !request) return null;
  return { replyId: last.id, request: messageText(request), reply };
}

/** The prompt for the small model. The reply's end is kept: that is where next steps are offered. */
export function followUpPrompt(exchange: { request: string; reply: string }): string {
  return [
    "Suggest the next message the user would most plausibly send in this chat.",
    "Write it as the user, in the user's language: one short instruction or question, at most 12 words, no quotes.",
    "It must move the work forward from the assistant's reply, such as a next step the reply offers or leaves open. Never thank, repeat the request, or ask what the reply already answers.",
    `Answer ${NO_SUGGESTION} unless one such message is clearly useful.`,
    "",
    "<user>",
    exchange.request.slice(0, REQUEST_LIMIT),
    "</user>",
    "<assistant>",
    exchange.reply.slice(-REPLY_LIMIT),
    "</assistant>",
  ].join("\n");
}

/** The suggestion in the model's answer, or null when it declined or did not give one sendable line. */
export function parseFollowUpSuggestion(answer: string): string | null {
  const line = answer.trim().replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  if (!line || line.length > SUGGESTION_LIMIT || /[\r\n<>]/.test(line)) return null;
  if (line.replace(/[^\p{L}]/gu, "").toUpperCase() === NO_SUGGESTION) return null;
  return line;
}
