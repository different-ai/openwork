/**
 * Transcript projection.
 *
 * A snapshot carries the thread exactly as OpenWork stores it. A transcript is
 * the flattened, comparable view of the same data: what each side said, what
 * it reasoned about, and which tools it called. Deriving it here keeps every
 * consumer from re-implementing part handling the way the desktop UI does.
 */
import type {
  HeadlessThreadMessage,
  HeadlessThreadSnapshot,
  HeadlessThreadTranscript,
  HeadlessTranscriptMessage,
  HeadlessTranscriptToolCall,
} from "./types.js";

function joinPartText(message: HeadlessThreadMessage, type: string): string {
  return message.parts
    .filter((part) => part.type === type && typeof part.text === "string")
    // Synthetic and ignored parts are engine bookkeeping; the UI hides them
    // and a transcript comparison must not see them either.
    .filter((part) => part.synthetic !== true && part.ignored !== true)
    .map((part) => part.text)
    .join("")
    .trim();
}

function toToolCalls(message: HeadlessThreadMessage): HeadlessTranscriptToolCall[] {
  return message.parts
    .filter((part) => part.type === "tool")
    .map((part) => ({
      partId: part.id,
      name: part.tool ?? "",
      callId: part.callId ?? null,
      status: part.toolStatus ?? null,
    }));
}

export function toTranscriptMessage(message: HeadlessThreadMessage): HeadlessTranscriptMessage {
  return {
    id: message.id,
    role: message.role,
    createdAt: message.createdAt,
    text: joinPartText(message, "text"),
    reasoning: joinPartText(message, "reasoning"),
    toolCalls: toToolCalls(message),
  };
}

export function toTranscript(snapshot: HeadlessThreadSnapshot): HeadlessThreadTranscript {
  const messages = snapshot.messages.map(toTranscriptMessage);
  const lastAssistant = messages.filter((message) => message.role === "assistant" && message.text).at(-1);
  return {
    threadId: snapshot.threadId,
    title: snapshot.title,
    status: snapshot.status,
    messages,
    finalAssistantText: lastAssistant ? lastAssistant.text : "",
  };
}

/**
 * True once the thread holds an assistant message that did not exist when a
 * turn was submitted. Paired with a non-running status this is what makes a
 * turn "finished" — a status read alone is ambiguous, because a thread is
 * still idle in the moment between accepting a prompt and starting work.
 */
export function hasAssistantReplySince(messages: HeadlessThreadMessage[], messageCountBefore: number): boolean {
  return messages.slice(messageCountBefore).some((message) => message.role === "assistant");
}
