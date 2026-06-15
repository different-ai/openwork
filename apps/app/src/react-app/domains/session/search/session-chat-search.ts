import type { UIMessage } from "ai";

function messageSearchText(message: UIMessage): string {
  return message.parts
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

export function countChatSearchMatches(messages: UIMessage[], query: string): number {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return 0;
  }

  let count = 0;
  for (const message of messages) {
    const text = messageSearchText(message).toLowerCase();
    let start = 0;
    while (true) {
      const index = text.indexOf(needle, start);
      if (index < 0) {
        break;
      }
      count += 1;
      start = index + needle.length;
    }
  }
  return count;
}
