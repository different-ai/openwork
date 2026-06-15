import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { countChatSearchMatches } from "../src/react-app/domains/session/search/session-chat-search";

function textMessage(id: string, text: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text }],
  };
}

describe("countChatSearchMatches", () => {
  test("counts every occurrence across messages", () => {
    const messages = [
      textMessage("a", "hello world"),
      textMessage("b", "hello again hello"),
    ];

    expect(countChatSearchMatches(messages, "hello")).toBe(3);
  });

  test("is case-insensitive", () => {
    expect(countChatSearchMatches([textMessage("a", "Hello HELLO")], "hello")).toBe(2);
  });

  test("returns zero for empty query", () => {
    expect(countChatSearchMatches([textMessage("a", "hello")], "   ")).toBe(0);
  });
});
