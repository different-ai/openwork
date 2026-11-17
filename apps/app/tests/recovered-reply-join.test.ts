import { describe, expect, test } from "bun:test";
import type { UIMessage } from "ai";

import { SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX } from "../src/app/types";
import { joinRecoveredReplies } from "../src/react-app/domains/session/sync/transcript-reconcile";

const text = (value: string): UIMessage["parts"][number] => ({ type: "text", text: value, state: "done" });
const message = (id: string, role: UIMessage["role"], parts: UIMessage["parts"]): UIMessage => ({ id, role, parts });
const errorFor = (id: string) => message(`${SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX}${id}`, "assistant", [text("Connection to the model dropped")]);
const texts = (messages: UIMessage[]) => messages.map((item) => item.parts.flatMap((part) => part.type === "text" ? [part.text] : []));

describe("joinRecoveredReplies", () => {
  test("a diagram split by a dropped connection renders as one block", () => {
    const messages = [
      message("user-1", "user", [text("Explain the architecture with a diagram")]),
      message("reply-1", "assistant", [{ type: "step-start" }, text("Intro\n\n```mermaid\nflowchart TB\n  Store[(\"Private mac")]),
      errorFor("reply-1"),
      message("reply-2", "assistant", [{ type: "step-start" }, { type: "reasoning", text: "resume", state: "done" }, text("OS archive\")]\n```\n\nDone.")]),
    ];
    const joined = joinRecoveredReplies(messages);
    expect(joined.map((item) => item.id)).toEqual(["user-1", "reply-2"]);
    expect(texts(joined)[1]).toEqual(["Intro\n\n```mermaid\nflowchart TB\n  Store[(\"Private macOS archive\")]\n```\n\nDone."]);
    expect(joinRecoveredReplies(messages)[1]).toBe(joined[1]);
  });

  test("earlier steps of the interrupted reply stay where they were", () => {
    const tool: UIMessage["parts"][number] = { type: "dynamic-tool", toolName: "read", toolCallId: "call-1", state: "output-available", input: {}, output: "ok" };
    const joined = joinRecoveredReplies([
      message("reply-1", "assistant", [tool, text("| a | b |\n| - ")]),
      errorFor("reply-1"),
      message("reply-2", "assistant", [text("| - |\n| 1 | 2 |")]),
    ]);
    expect(joined.map((item) => item.id)).toEqual(["reply-1", "reply-2"]);
    expect(joined[0]?.parts).toEqual([tool]);
    expect(texts(joined)[1]).toEqual(["| a | b |\n| - | - |\n| 1 | 2 |"]);
  });

  test("a failed reply the person retried is left alone", () => {
    const retried = [
      message("reply-1", "assistant", [text("Half an ans")]),
      errorFor("reply-1"),
      message("user-2", "user", [text("Continue the interrupted task from the current state.")]),
      message("reply-2", "assistant", [text("Picking up where it stopped.")]),
    ];
    expect(joinRecoveredReplies(retried)).toBe(retried);
    const failed = [message("reply-1", "assistant", [text("Half an ans")]), errorFor("reply-1")];
    expect(joinRecoveredReplies(failed)).toBe(failed);
  });
});
